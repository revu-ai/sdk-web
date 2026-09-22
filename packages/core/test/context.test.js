/**
 * @file Tests for the Context layer - the per-event environment metadata
 * (UA, screen, viewport, language, timezone, referrer, connectivity).
 *
 * Tests run under happy-dom, so navigator / window / Intl all return real
 * (synthetic) values. Where the real value is not deterministic enough to
 * assert exactly (UA string, timezone), we assert shape and presence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "../src/context.js";

const ORIGINAL_HREF = location.href;

afterEach(() => {
  // Several tests below rewrite the URL via history.replaceState to seed
  // search-string fixtures. Put it back so the suite stays independent
  // of run order.
  history.replaceState({}, "", ORIGINAL_HREF);
});

describe("Context > session-scoped fields", () => {
  test("captures user agent and language on construction", () => {
    const ctx = new Context().build();
    expect(typeof ctx.user_agent).toBe("string");
    expect(/** @type {string} */ (ctx.user_agent).length).toBeGreaterThan(0);
    expect(typeof ctx.language).toBe("string");
  });

  test("captures screen geometry and pixel ratio", () => {
    const ctx = new Context().build();
    expect(typeof ctx.screen_width).toBe("number");
    expect(typeof ctx.screen_height).toBe("number");
    expect(typeof ctx.screen_pixel_ratio).toBe("number");
  });

  test("captures a timezone string via Intl", () => {
    const ctx = new Context().build();
    expect(typeof ctx.timezone).toBe("string");
    expect(/** @type {string} */ (ctx.timezone).length).toBeGreaterThan(0);
  });

  test("session fields are stable across multiple build() calls", () => {
    const c = new Context();
    const first = c.build();
    const second = c.build();
    expect(second.user_agent).toBe(first.user_agent);
    expect(second.language).toBe(first.language);
    expect(second.screen_width).toBe(first.screen_width);
  });
});

describe("Context > automation signal (navigator.webdriver)", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "webdriver");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "webdriver", original);
    else { try { delete /** @type {any} */ (navigator).webdriver; } catch {} }
  });

  test("stamps webdriver:true when the browser reports automation", () => {
    Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
    const ctx = new Context().build();
    expect(ctx.webdriver).toBe(true);
  });

  test("omits webdriver for a real browser, so no bytes are added", () => {
    Object.defineProperty(navigator, "webdriver", { value: false, configurable: true });
    const ctx = new Context().build();
    expect("webdriver" in ctx).toBe(false);
  });
});

describe("Context > User-Agent Client Hints (low-entropy set)", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "userAgentData");
  const restore = () => {
    if (original) Object.defineProperty(navigator, "userAgentData", original);
    else { try { delete /** @type {any} */ (navigator).userAgentData; } catch {} }
  };
  const stub = (/** @type {any} */ value) =>
    Object.defineProperty(navigator, "userAgentData", { value, configurable: true });

  afterEach(restore);

  test("stamps brands, mobile, and platform when the browser exposes them", () => {
    stub({
      brands: [
        { brand: "Not_A Brand", version: "8" },
        { brand: "Chromium", version: "142" },
      ],
      mobile: false,
      platform: "macOS",
    });
    const ctx = new Context().build();
    expect(ctx.ua_brands).toEqual([
      { brand: "Not_A Brand", version: "8" },
      { brand: "Chromium", version: "142" },
    ]);
    expect(ctx.ua_mobile).toBe(false);
    expect(ctx.ua_platform).toBe("macOS");
  });

  test("passes the brand list through verbatim, GREASE entry included", () => {
    // The server compares the list against the UA string, so the randomized
    // GREASE entry must survive rather than being filtered as noise.
    stub({
      brands: [{ brand: "Not/A)Brand", version: "99" }, { brand: "Chromium", version: "142" }],
      mobile: false,
      platform: "Windows",
    });
    const ctx = new Context().build();
    expect(/** @type {any[]} */ (ctx.ua_brands).map((b) => b.brand)).toEqual([
      "Not/A)Brand",
      "Chromium",
    ]);
  });

  test("copies the brand list, so a frozen engine array is not shared onto events", () => {
    // navigator.userAgentData.brands is a FrozenArray. Referencing it would
    // put one frozen array on the session context and on every event built
    // from it; the copy keeps the bucket ordinary, mutable data.
    const frozen = Object.freeze([Object.freeze({ brand: "Chromium", version: "142" })]);
    stub({ brands: frozen, mobile: false, platform: "macOS" });
    const built = new Context().build();
    const list = /** @type {any[]} */ (built.ua_brands);
    expect(list).not.toBe(frozen);
    expect(Object.isFrozen(list)).toBe(false);
    expect(Object.isFrozen(list[0])).toBe(false);
    // A beforeSend-style adjustment must not throw and must not reach the engine.
    expect(() => list.push({ brand: "Added", version: "1" })).not.toThrow();
    expect(frozen.length).toBe(1);
  });

  test("reads the engine once per page load, but copies per event", () => {
    // The engine read is session-scoped; the per-event copy is what keeps a
    // beforeSend edit on one event out of every later event.
    let reads = 0;
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      get() {
        reads += 1;
        return { brands: [{ brand: "Chromium", version: "142" }], mobile: false, platform: "macOS" };
      },
    });
    const c = new Context();
    const first = /** @type {any[]} */ (c.build().ua_brands);
    const second = /** @type {any[]} */ (c.build().ua_brands);
    expect(reads).toBe(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  test("a beforeSend-style edit on one event does not reach the next", () => {
    stub({ brands: [{ brand: "Chromium", version: "142" }], mobile: false, platform: "macOS" });
    const c = new Context();
    const first = /** @type {any[]} */ (c.build().ua_brands);
    first.push({ brand: "Injected", version: "1" });
    first[0].version = "999";
    const next = /** @type {any[]} */ (c.build().ua_brands);
    expect(next).toEqual([{ brand: "Chromium", version: "142" }]);
  });

  test("omits the whole trio on a browser without the API", () => {
    stub(undefined);
    const ctx = new Context().build();
    expect("ua_brands" in ctx).toBe(false);
    expect("ua_mobile" in ctx).toBe(false);
    expect("ua_platform" in ctx).toBe(false);
  });

  test("stamps only the fields the browser actually reports", () => {
    stub({ mobile: true });
    const ctx = new Context().build();
    expect("ua_brands" in ctx).toBe(false);
    expect(ctx.ua_mobile).toBe(true);
    expect("ua_platform" in ctx).toBe(false);
  });

  test("does not read the async high-entropy set", () => {
    let called = false;
    stub({
      brands: [],
      mobile: false,
      platform: "macOS",
      getHighEntropyValues: () => { called = true; return Promise.resolve({}); },
    });
    new Context().build();
    expect(called).toBe(false);
  });
});

describe("Context > navigator.languages", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "languages");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "languages", original);
    else { try { delete /** @type {any} */ (navigator).languages; } catch {} }
  });

  test("captures the plural list alongside the singular language", () => {
    Object.defineProperty(navigator, "languages", {
      value: ["en-US", "en", "fr"],
      configurable: true,
    });
    const ctx = new Context().build();
    expect(ctx.languages).toEqual(["en-US", "en", "fr"]);
  });

  test("keeps an empty list, since an empty list is itself the signal", () => {
    Object.defineProperty(navigator, "languages", { value: [], configurable: true });
    const ctx = new Context().build();
    expect(ctx.languages).toEqual([]);
  });

  test("copies the engine array, so it is not shared onto events", () => {
    // navigator.languages is a FrozenArray owned by the engine, same as
    // userAgentData.brands. Referencing it would put the engine's own frozen
    // array on every event.
    const live = Object.freeze(["en-US", "en"]);
    Object.defineProperty(navigator, "languages", { value: live, configurable: true });
    const c = new Context();
    const first = /** @type {string[]} */ (c.build().languages);
    const second = /** @type {string[]} */ (c.build().languages);
    expect(first).toEqual(["en-US", "en"]);
    expect(first).not.toBe(live);
    expect(second).not.toBe(first);
    expect(Object.isFrozen(first)).toBe(false);
  });

  test("a beforeSend-style edit on one event does not reach the next", () => {
    Object.defineProperty(navigator, "languages", {
      value: ["en-US", "en"],
      configurable: true,
    });
    const c = new Context();
    const first = /** @type {string[]} */ (c.build().languages);
    first.push("INJECTED");
    expect(/** @type {string[]} */ (c.build().languages)).toEqual(["en-US", "en"]);
  });

  test("omits the field when the browser does not expose an array", () => {
    Object.defineProperty(navigator, "languages", { value: undefined, configurable: true });
    const ctx = new Context().build();
    expect("languages" in ctx).toBe(false);
  });
});

describe("Context > navigation type", () => {
  const original = performance.getEntriesByType;
  afterEach(() => {
    performance.getEntriesByType = original;
  });

  test("captures the navigation entry type", () => {
    // @ts-expect-error test stub
    performance.getEntriesByType = (/** @type {string} */ type) =>
      type === "navigation" ? [{ type: "back_forward" }] : [];
    const ctx = new Context().build();
    expect(ctx.navigation_type).toBe("back_forward");
  });

  test("omits the field when there is no navigation entry", () => {
    // @ts-expect-error test stub
    performance.getEntriesByType = () => [];
    const ctx = new Context().build();
    expect("navigation_type" in ctx).toBe(false);
  });

  test("never throws into the host when Navigation Timing is unavailable", () => {
    // @ts-expect-error test stub
    performance.getEntriesByType = () => { throw new Error("unsupported"); };
    expect(() => new Context().build()).not.toThrow();
  });
});

describe("Context > hostile navigator getters", () => {
  // A UA-spoofing extension or privacy tool can replace any navigator
  // property with a getter of its own. Unguarded, a throwing one would leave
  // the Context constructor, and init() could only contain it by failing the
  // whole SDK: the host page survives, but the visitor produces no analytics
  // at all. Each case below must cost at most the field it belongs to.
  const saved = ["userAgentData", "languages", "userAgent", "webdriver"].map((k) => [
    k,
    Object.getOwnPropertyDescriptor(navigator, k),
  ]);
  afterEach(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(navigator, k, d);
      else { try { delete /** @type {any} */ (navigator)[k]; } catch {} }
    }
  });
  const explode = (/** @type {string} */ key) =>
    Object.defineProperty(navigator, key, {
      configurable: true,
      get() { throw new Error(`${key} spoofer threw`); },
    });

  for (const key of ["userAgentData", "languages", "userAgent", "webdriver"]) {
    test(`survives a throwing ${key} getter`, () => {
      explode(key);
      expect(() => new Context().build()).not.toThrow();
    });
  }

  test("a throwing userAgentData still leaves the earlier signals intact", () => {
    // userAgentData is read last precisely so a throw there is cheap.
    Object.defineProperty(navigator, "languages", {
      value: ["en-US", "en"],
      configurable: true,
    });
    Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
    explode("userAgentData");
    const ctx = new Context().build();
    expect(ctx.languages).toEqual(["en-US", "en"]);
    expect(ctx.webdriver).toBe(true);
    expect("ua_brands" in ctx).toBe(false);
    // Fields collected outside the navigator block are untouched either way.
    expect(typeof ctx.timezone).toBe("string");
  });
});

describe("Context > URL query is not parsed on the SDK", () => {
  // UTM and click-id derivation lives on the server, which parses them
  // from `$pageview.properties.url` and writes the result to the visitor
  // rollup's landing columns. The SDK only captures the raw URL on the
  // pageview (set in capture.js); the per-event Context layer must not
  // stamp any `$utm_*` / `$gclid` / `$fbclid` properties.
  test("does not stamp $utm_* or click-id properties on the context", () => {
    history.replaceState(
      {},
      "",
      "/?utm_source=google&utm_medium=cpc&utm_campaign=summer&gclid=abc123&fbclid=xyz789",
    );
    const ctx = new Context().build();
    expect(ctx.utm_source).toBeUndefined();
    expect(ctx.utm_medium).toBeUndefined();
    expect(ctx.utm_campaign).toBeUndefined();
    expect(ctx.utm_term).toBeUndefined();
    expect(ctx.utm_content).toBeUndefined();
    expect(ctx.gclid).toBeUndefined();
    expect(ctx.fbclid).toBeUndefined();
  });
});

describe("Context > environment", () => {
  test("stamps $environment when provided", () => {
    const ctx = new Context({ environment: "staging" }).build();
    expect(ctx.environment).toBe("staging");
  });

  test("omits $environment when no opt is provided", () => {
    const ctx = new Context().build();
    expect(ctx.environment).toBeUndefined();
  });

  test("$environment is session-stable across build() calls", () => {
    const c = new Context({ environment: "development" });
    expect(c.build().environment).toBe("development");
    expect(c.build().environment).toBe("development");
  });
});

describe("Context > referrer", () => {
  test("captures document.referrer when present", () => {
    // happy-dom doesn't set document.referrer from the registrator URL, so
    // we assert the negative case (absent referrer omits the field entirely).
    const ctx = new Context().build();
    if (document.referrer) {
      expect(ctx.initial_referrer).toBe(document.referrer);
      expect(typeof ctx.initial_referrer_host).toBe("string");
    } else {
      expect(ctx.initial_referrer).toBeUndefined();
      expect(ctx.initial_referrer_host).toBeUndefined();
    }
  });
});

describe("Context > per-event volatile fields", () => {
  test("samples viewport size on every build() call", () => {
    const ctx = new Context().build();
    expect(typeof ctx.viewport_width).toBe("number");
    expect(typeof ctx.viewport_height).toBe("number");
  });

  test("samples online state", () => {
    const ctx = new Context().build();
    expect(typeof ctx.online).toBe("boolean");
  });

  test("samples Network Information API fields when present", () => {
    // Stub navigator.connection. The Context module reads it defensively
    // so absent on real Safari/Firefox just means the field is omitted.
    const original = Object.getOwnPropertyDescriptor(navigator, "connection");
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: {
        effectiveType: "4g",
        downlink: 9.5,
        rtt: 50,
        saveData: false,
      },
    });
    try {
      const ctx = new Context().build();
      expect(ctx.connection_type).toBe("4g");
      expect(ctx.connection_downlink_mbps).toBe(9.5);
      expect(ctx.connection_rtt_ms).toBe(50);
      expect(ctx.save_data).toBe(false);
    } finally {
      if (original) {
        Object.defineProperty(navigator, "connection", original);
      } else {
        // @ts-expect-error - removing the synthetic property.
        delete navigator.connection;
      }
    }
  });

  test("volatile fields refresh on each build() call (resize between events)", () => {
    const c = new Context();
    const first = c.build();
    // Mutate viewport (happy-dom honours direct writes for synthetic tests).
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth + 1 });
    try {
      const second = c.build();
      expect(second.viewport_width).toBe(originalWidth + 1);
      expect(second.viewport_width).not.toBe(first.viewport_width);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });
});

describe("Context > merge order", () => {
  test("session and volatile keys coexist on the built payload", () => {
    const ctx = new Context().build();
    expect(typeof ctx.user_agent).toBe("string"); // session
    expect(typeof ctx.viewport_width).toBe("number"); // volatile
  });
});
