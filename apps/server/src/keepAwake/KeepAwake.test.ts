import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KeepAwake from "./KeepAwake.ts";

function fixture(platform: NodeJS.Platform = "darwin", host = "192.168.40.234") {
  const assertions: Array<{ args: ReadonlyArray<string>; released: boolean }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        assert.equal(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") throw new Error("Expected standard command");
        assert.equal(command.command, "/usr/bin/caffeinate");
        const assertion = { args: command.args, released: false };
        assertions.push(assertion);
        return assertion;
      }),
      (assertion) =>
        Effect.sync(() => {
          assertion.released = true;
        }),
    ).pipe(
      Effect.map(() =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1234),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    ServerSettings.layerTest(),
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        return { ...config, host };
      }),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-keep-awake-test-" })),
      Layer.provide(NodeServices.layer),
    ),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcessPlatform, platform),
  );
  return {
    assertions,
    layer: KeepAwake.layer.pipe(Layer.provideMerge(dependencies)),
  };
}

it.effect(
  "is opt-in, keeps the host awake without duplicate assertions, and releases on disable",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const keepAwake = yield* KeepAwake.KeepAwake;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* keepAwake.refresh;
      assert.lengthOf(test.assertions, 0);
      yield* settings.updateSettings({ keepAwakeForRemoteAccess: true });
      yield* keepAwake.refresh;
      assert.deepEqual(test.assertions[0]?.args, ["-s", "-w", String(process.pid)]);
      yield* keepAwake.refresh;
      assert.lengthOf(test.assertions, 1);
      assert.isFalse(test.assertions[0]!.released);
      yield* settings.updateSettings({ keepAwakeForRemoteAccess: false });
      yield* keepAwake.refresh;
      assert.isTrue(test.assertions[0]!.released);
      yield* settings.updateSettings({ keepAwakeForRemoteAccess: true });
      yield* keepAwake.refresh;
      assert.lengthOf(test.assertions, 2);
      assert.isFalse(test.assertions[1]!.released);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("releases the assertion when the server scope closes", () => {
  const test = fixture();
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const keepAwake = yield* KeepAwake.KeepAwake;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ keepAwakeForRemoteAccess: true });
      yield* keepAwake.refresh;
      assert.isFalse(test.assertions[0]!.released);
    }).pipe(Effect.provide(test.layer));
    assert.isTrue(test.assertions[0]!.released);
  });
});

it.effect("does not launch a macOS utility on other platforms", () => {
  const test = fixture("linux");
  return Effect.gen(function* () {
    const keepAwake = yield* KeepAwake.KeepAwake;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      keepAwakeForRemoteAccess: true,
    });
    yield* keepAwake.refresh;
    assert.lengthOf(test.assertions, 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect.each(["127.0.0.1", "localhost", "::1"])(
  "does not keep a local-only host awake (%s), even with the preference enabled",
  (host) => {
    const test = fixture("darwin", host);
    return Effect.gen(function* () {
      const keepAwake = yield* KeepAwake.KeepAwake;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ keepAwakeForRemoteAccess: true });
      yield* keepAwake.refresh;
      assert.lengthOf(test.assertions, 0);
      assert.isTrue((yield* settings.getSettings).keepAwakeForRemoteAccess);
    }).pipe(Effect.provide(test.layer));
  },
);
