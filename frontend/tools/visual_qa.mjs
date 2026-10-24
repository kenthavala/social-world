// Visual QA: drive the real app in Chromium, capture every screen at four widths,
// and record console errors / failed requests / layout overflow so problems are
// reported rather than assumed.
//
//   node tools/visual_qa.mjs http://127.0.0.1:8021
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:8021";
const RUN_ID = process.argv[3] || "run_demo_congestion";
const OUT = "docs/screenshots/qa2";
const VIEWPORTS = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 720 },
  { name: "390", width: 390, height: 844 },
];

mkdirSync(OUT, { recursive: true });

const problems = [];
const shots = [];

async function snap(page, label, vp) {
  const file = join(OUT, `${vp.name}_${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(file);

  // Layout checks that catch the defects the brief calls out.
  const audit = await page.evaluate(() => {
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
          cls: (el.className || "").toString().slice(0, 60),
          right: Math.round(r.right),
        });
      }
    }
    return {
      overflowX,
      offenders: offenders.slice(0, 5),
      title: document.querySelector("h1, h2")?.textContent?.slice(0, 60) || "",
      bodyText: document.body.innerText.length,
    };
  });
  if (audit.overflowX > 2) {
    problems.push({ vp: vp.name, view: label, issue: `horizontal overflow ${audit.overflowX}px`, offenders: audit.offenders });
  }
  if (audit.bodyText < 40) {
    problems.push({ vp: vp.name, view: label, issue: "page looks empty (<40 chars of text)" });
  }
  return audit;
}

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on("requestfailed", (r) => {
      const u = r.url();
      if (u.includes("/api/") || u.endsWith(".js") || u.endsWith(".css")) {
        consoleErrors.push(`requestfailed: ${u.slice(0, 120)}`);
      }
    });

    // Home (the product entry point) and the simulations list
    await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await snap(page, "home", vp);

    await page.goto(`${BASE}/#/simulations`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await snap(page, "simulations", vp);

    // Documents
    await page.goto(`${BASE}/#/documents`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await snap(page, "documents", vp);

    // Wizard
    await page.goto(`${BASE}/#/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await snap(page, "wizard", vp);

    // Settings
    await page.goto(`${BASE}/#/settings`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await snap(page, "settings", vp);

    // Run room — click through the tabs like a user would.
    await page.goto(`${BASE}/#/run/${RUN_ID}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await snap(page, "run_feed", vp);

    const tabs = [
      ["Agents", "run_agents"],
      ["Connections", "run_connections"],
      ["Findings", "run_findings"],
      ["Quality", "run_quality"],
    ];
    for (const [label, file] of tabs) {
      const btn = page.getByRole("button", { name: new RegExp(`^${label}`, "i") }).first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(label === "Connections" ? 2600 : 1500);
        await snap(page, file, vp);
      } else {
        problems.push({ vp: vp.name, view: file, issue: `tab button "${label}" not found` });
      }
    }

    // Connections: select an agent from the list and confirm the detail panel.
    if (vp.name === "1440") {
      const agentTab = page.getByRole("button", { name: /^Connections/i }).first();
      if (await agentTab.count()) {
        await agentTab.click();
        await page.waitForTimeout(2200);
        const listBtn = page.locator("label.list-row input[type=checkbox]").first();
        if (await listBtn.count()) {
          await listBtn.click();
          await page.waitForTimeout(700);
          await snap(page, "run_connections_selected", vp);
        } else {
          problems.push({ vp: vp.name, view: "run_connections", issue: "no selectable agent rows in list" });
        }
      }
    }

    if (consoleErrors.length) {
      problems.push({ vp: vp.name, view: "console", issue: consoleErrors.slice(0, 6).join(" | ") });
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
  console.log("No layout/console problems detected.");
}
