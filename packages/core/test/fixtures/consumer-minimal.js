/**
 * @file Minimal downstream consumer fixture.
 *
 * Represents what a real host application's bundle would look like after
 * tree-shaking when they only use the public surface: init + identify +
 * track + reset. The tree-shake test bundles this entry through Bun.build
 * with minification on and asserts the resulting size envelope.
 *
 * Future expansion: when subpath plugins exist (`@revu-ai/core/exceptions`,
 * etc.), add sibling fixtures (`consumer-with-exceptions.js`) and assert
 * that this fixture's bundle does NOT contain markers from those plugins.
 * That is what catches the "subpath does not tree-shake" condition before
 * customers hit it.
 */

import revu from "../../src/index.js";

revu.init({ apiKey: "test_key" });
revu.identify("user-42");
revu.capture("test_event", { foo: "bar" });
revu.reset();
