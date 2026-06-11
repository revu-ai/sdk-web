/**
 * @file Tests for the Context layer - the per-event environment metadata
 * (UA, screen, viewport, language, timezone, referrer, UTM, connectivity).
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
  // UTM / search-string fixtures. Put it back so the suite stays
  // independent of run order.
  history.replaceState({}, "", ORIGINAL_HREF);
});

describe("Context > session-scoped fields", () => {
  test("captures user agent and language on construction", () => {
    const ctx = new Context().build();
    expect(typeof ctx.$user_agent).toBe("string");
    expect(/** @type {string} */ (ctx.$user_agent).length).toBeGreaterThan(0);
    expect(typeof ctx.$language).toBe("string");
  });

  test("captures screen geometry and pixel ratio", () => {
    const ctx = new Context().build();
    expect(typeof ctx.$screen_width).toBe("number");
    expect(typeof ctx.$screen_height).toBe("number");
    expect(typeof ctx.$screen_pixel_ratio).toBe("number");
  });

  test("captures a timezone string via Intl", () => {
    const ctx = new Context().build();
    expect(typeof ctx.$timezone).toBe("string");
    expect(/** @type {string} */ (ctx.$timezone).length).toBeGreaterThan(0);
  });

  test("session fields are stable across multiple build() calls", () => {
    const c = new Context();
    const first = c.build();
    const second = c.build();
    expect(second.$user_agent).toBe(first.$user_agent);
    expect(second.$language).toBe(first.$language);
    expect(second.$screen_width).toBe(first.$screen_width);
  });
});

describe("Context > UTM and click ids", () => {
  test("extracts the standard UTM keys from the URL", () => {
    history.replaceState(
      {},
      "",
      "/?utm_source=google&utm_medium=cpc&utm_campaign=summer&utm_term=shoes&utm_content=hero",
    );
    const ctx = new Context().build();
    expect(ctx.$utm_source).toBe("google");
    expect(ctx.$utm_medium).toBe("cpc");
    expect(ctx.$utm_campaign).toBe("summer");
    expect(ctx.$utm_term).toBe("shoes");
    expect(ctx.$utm_content).toBe("hero");
  });

  test("extracts gclid and fbclid when present", () => {
    history.replaceState({}, "", "/?gclid=abc123&fbclid=xyz789");
    const ctx = new Context().build();
    expect(ctx.$gclid).toBe("abc123");
    expect(ctx.$fbclid).toBe("xyz789");
  });

  test("absent UTM keys are not in the payload (no empty strings)", () => {
    history.replaceState({}, "", "/?other=ignored");
    const ctx = new Context().build();
    expect(ctx.$utm_source).toBeUndefined();
    expect(ctx.$gclid).toBeUndefined();
  });

  test("a session-scoped UTM persists even after the URL changes mid-session", () => {
    history.replaceState({}, "", "/?utm_source=google");
    const c = new Context();
    history.replaceState({}, "", "/about"); // simulate SPA navigation
    // The UTM landed on the FIRST page; subsequent SPA pages still get
    // attributed to it because session context is built once.
    expect(c.build().$utm_source).toBe("google");
  });
});

describe("Context > environment", () => {
  test("stamps $environment when provided", () => {
    const ctx = new Context({ environment: "staging" }).build();
    expect(ctx.$environment).toBe("staging");
  });

  test("omits $environment when no opt is provided", () => {
    const ctx = new Context().build();
    expect(ctx.$environment).toBeUndefined();
  });

  test("$environment is session-stable across build() calls", () => {
    const c = new Context({ environment: "development" });
    expect(c.build().$environment).toBe("development");
    expect(c.build().$environment).toBe("development");
  });
});

describe("Context > referrer", () => {
  test("captures document.referrer when present", () => {
    // happy-dom doesn't set document.referrer from the registrator URL, so
    // we assert the negative case (absent referrer omits the field entirely).
    const ctx = new Context().build();
    if (document.referrer) {
      expect(ctx.$initial_referrer).toBe(document.referrer);
      expect(typeof ctx.$initial_referrer_host).toBe("string");
    } else {
      expect(ctx.$initial_referrer).toBeUndefined();
      expect(ctx.$initial_referrer_host).toBeUndefined();
    }
  });
});

describe("Context > per-event volatile fields", () => {
  test("samples viewport size on every build() call", () => {
    const ctx = new Context().build();
    expect(typeof ctx.$viewport_width).toBe("number");
    expect(typeof ctx.$viewport_height).toBe("number");
  });

  test("samples online state", () => {
    const ctx = new Context().build();
    expect(typeof ctx.$online).toBe("boolean");
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
      expect(ctx.$connection_type).toBe("4g");
      expect(ctx.$connection_downlink_mbps).toBe(9.5);
      expect(ctx.$connection_rtt_ms).toBe(50);
      expect(ctx.$save_data).toBe(false);
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
      expect(second.$viewport_width).toBe(originalWidth + 1);
      expect(second.$viewport_width).not.toBe(first.$viewport_width);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });
});

describe("Context > merge order", () => {
  test("session and volatile keys coexist on the built payload", () => {
    const ctx = new Context().build();
    expect(typeof ctx.$user_agent).toBe("string"); // session
    expect(typeof ctx.$viewport_width).toBe("number"); // volatile
  });
});
