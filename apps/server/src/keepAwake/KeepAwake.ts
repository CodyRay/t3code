import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { isRemoteReachableHost } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

export class KeepAwakeError extends Schema.TaggedError<KeepAwakeError>()("KeepAwakeError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not update Keep awake.";
  }
}

export class KeepAwake extends Context.Service<
  KeepAwake,
  {
    readonly refresh: Effect.Effect<void, KeepAwakeError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/keepAwake/KeepAwake") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lifetime = yield* Effect.scope;
  const semaphore = yield* Semaphore.make(1);
  let current: Scope.Closeable | undefined;

  const refresh = semaphore.withPermits(1)(
    Effect.gen(function* () {
      if (platform !== "darwin") return;
      const settings = yield* settingsService.getSettings;
      const enabled = settings.keepAwakeForRemoteAccess && isRemoteReachableHost(config.host);
      if (enabled === (current !== undefined)) return;
      if (current) {
        yield* Scope.close(current, Exit.void);
        current = undefined;
      }
      if (!enabled) return;
      const scope = yield* Scope.fork(lifetime, "sequential");
      // -s is enforced by macOS only on AC power. The display can still turn off.
      // -w also releases the assertion if the server exits without running its finalizers.
      yield* spawner
        .spawn(
          ChildProcess.make("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      current = scope;
    }).pipe(Effect.mapError((cause) => new KeepAwakeError({ cause }))),
  );

  const refreshSafely = refresh.pipe(
    Effect.catch((error) => Effect.logWarning("Keep awake failed", error)),
  );
  const start = Effect.gen(function* () {
    if (platform !== "darwin") return;
    const settingsChanges = yield* settingsService.subscribeChanges;
    yield* forkParked(
      Effect.gen(function* () {
        yield* refreshSafely;
        yield* settingsChanges.pipe(Stream.runForEach(() => refreshSafely));
      }),
    );
  });

  return KeepAwake.of({ refresh, start });
});

export const layer = Layer.effect(KeepAwake, make);
