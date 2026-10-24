// Visual + accessibility QA: drive the real app in Chromium at five widths, capture
// every screen, and record measurable problems (overflow, empty pages, unlabelled
// controls, unreadable contrast, console errors). Nothing is assumed.
//
//   node tools/visual_qa.mjs <base-url> <run-id>
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8021";
const RUN_ID = process.argv[3] || "run_demo_congestion";
const OUT = process.env.QA_OUT || "docs/screenshots/qa3";

const VIEWPORTS = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 720 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
];

mkdirSync(OUT, { recursive: true });

const problems = [];
const shots = [];

async function audit(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;

    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > doc.clientWidth + 2) {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.position === "absolute") continue;
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 50),
          right: Math.round(r.right),
        });
      }
    }

    const nameOf = (el) => (
      el.getAttribute("aria-label")
      || (el.labels && el.labels.length ? (el.labels[0].innerText || "").trim().slice(0, 40) : "")
      || (el.closest("label") ? (el.closest("label").innerText || "").trim().slice(0, 40) : "")
      || el.getAttribute("title")
      || (el.innerText || "").trim().slice(0, 40)
      || el.getAttribute("alt")
      || ""
    );
    const unlabelled = [];
    for (const el of document.querySelectorAll("button, a[href], input, select, textarea")) {
      if (el.closest("[aria-hidden=true]")) continue;
      const visible = el.getBoundingClientRect().width > 0;
      if (!visible) continue;
      if (!nameOf(el)) {
        unlabelled.push(el.tagName.toLowerCase() + "." + (el.className || "").toString().slice(0, 30));
      }
    }

    // Contrast: rather than guessing a background by walking ancestors (which
    // produces false positives on layered surfaces), report the design tokens'
    // ratios once. Text tokens must clear 4.5:1 on the panel surfaces.
    const cssText = [...document.styleSheets]
      .flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } })
      .join("\n");
    const token = (name) => {
      const m = cssText.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
      return m ? m[1] : null;
    };
    const relLum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratioOf = (a, b) => {
      const la = relLum(a), lb = relLum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const tokens = {};
    for (const bg of ["bg-0", "bg-1", "bg-2"]) {
      for (const fg of ["fg-1", "fg-2", "fg-3"]) {
        const b = token(bg), f = token(fg);
        if (b && f) tokens[`${fg}/${bg}`] = Math.round(ratioOf(f, b) * 10) / 10;
      }
    }

    return {
      overflowX, offenders: offenders.slice(0, 4),
      unlabelled: [...new Set(unlabelled)].slice(0, 6),
      tokens,
      textLen: document.body.innerText.length,
      h1: (document.querySelector("h1")?.textContent || "").slice(0, 60),
    };
  });
}

async function snap(page, label, vp) {
  const file = join(OUT, `${vp.name}_${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(file);
  const a = await audit(page);
  if (a.overflowX > 2) {
    problems.push({ vp: vp.name, view: label, issue: `horizontal overflow ${a.overflowX}px`, offenders: a.offenders });
  }
  if (a.textLen < 40) problems.push({ vp: vp.name, view: label, issue: "page looks empty" });
  if (a.unlabelled.length) {
    problems.push({ vp: vp.name, view: label, issue: "unlabelled controls", detail: a.unlabelled });
  }
  // Text tokens must clear 4.5:1 on panel surfaces; report once per page audit.
  const weakTokens = Object.entries(a.tokens || {}).filter(([, r]) => r < 4.5);
  if (weakTokens.length && label === "home") {
    problems.push({ vp: vp.name, view: label, issue: "text token below 4.5:1", detail: weakTokens });
  }
  return a;
}

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));

    const go = async (hash, wait = 900) => {
      await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(wait);
    };

    await go("#/");
    await snap(page, "home", vp);

    await go("#/simulations", 700);
    await snap(page, "simulations", vp);

    await go("#/documents", 1100);
    await snap(page, "documents", vp);

    await go("#/new", 800);
    await snap(page, "wizard", vp);

    await go("#/settings", 800);
    await snap(page, "settings", vp);

    await go(`#/run/${RUN_ID}`, 1400);
    await snap(page, "run_feed", vp);

    for (const [label, file, wait] of [
      ["Agents", "run_agents", 1400],
      ["Connections", "run_connections", 2800],
      ["Findings", "run_findings", 1600],
      ["Quality", "run_quality", 1600],
    ]) {
      const btn = page.getByRole("button", { name: new RegExp(`^${label}`, "i") }).first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(wait);
        await snap(page, file, vp);
      } else {
        problems.push({ vp: vp.name, view: file, issue: `tab "${label}" not found` });
      }
    }

    // Keyboard reachability: Tab from the top and confirm focus lands on real controls.
    await go(`#/run/${RUN_ID}`, 1200);
    const focusTrail = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      focusTrail.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 30),
          outline: cs.outlineStyle === "none" && cs.boxShadow === "none",
        };
      }));
    }
    const invisibleFocus = focusTrail.filter(
      (f) => f && f.tag !== "body" && f.label && f.outline && f.tag !== "html");
    if (invisibleFocus.length) {
      problems.push({ vp: vp.name, view: "keyboard", issue: "focus not visible", detail: invisibleFocus });
    }

    if (errors.length) {
      problems.push({ vp: vp.name, view: "console", issue: errors.slice(0, 5).join(" | ") });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

writeFileSync(join(OUT, "report.json"), JSON.stringify({ shots, problems }, null, 2));
console.log(`captured ${shots.length} screenshots into ${OUT}`);
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(" -", JSON.stringify(p));
} else {
  console.log("No problems detected.");
}
