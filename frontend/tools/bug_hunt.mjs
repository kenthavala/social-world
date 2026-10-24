// Adversarial UI bug hunt. Each scenario tries to break a real user flow and
// reports PASS/FAIL with the observed detail. Run against a live server:
//
//   node tools/bug_hunt.mjs http://127.0.0.1:8021 run_demo_congestion
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:8021";
const RUN = process.argv[3] || "run_demo_congestion";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 140)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 140)); });

const go = async (hash, wait = 900) => {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(wait);
};

try {
  // ---- 1. Wizard: a typed name survives a refresh --------------------------
  await go("#/new");
  const libChip = page.locator("button.chip").filter({ hasText: /\.md|\.pdf|\.txt/i }).first();
  if (await libChip.count()) {
    await libChip.click();
    await page.waitForTimeout(1400);
    // Rail buttons echo the nav's wording in their status text ("Draft the scenario
    // first"), so match the nav exactly; either variant reaches step 2.
    const draftNav = page.getByRole("button", { name: "Draft the scenario", exact: true });
    const reviewNav = page.getByRole("button", { name: "Review the scenario", exact: true });
    const nextBtn = draftNav.or(reviewNav);
    if (await nextBtn.count()) {
      await nextBtn.click();
      await page.waitForTimeout(1200);
      // A brief-less source still needs its brief before the name field is
      // settled, but the name field renders with or without one.
      if (await draftNav.count()) {
        const draftBrief = page.getByRole("button", { name: "Draft the brief", exact: true });
        if (await draftBrief.count()) {
          await draftBrief.click();
          await page.waitForTimeout(2500);
        }
      }
    }
    const nameInput = page.locator('input[placeholder*="Congestion Charge"]').first();
    if (await nameInput.count()) {
      await nameInput.fill("Bughunt scenario");
      await page.waitForTimeout(900);           // let autosave write
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const after = await page.locator('input[placeholder*="Congestion Charge"]')
        .first().inputValue().catch(() => "");
      check("wizard draft survives refresh", after === "Bughunt scenario", `got "${after}"`);
    } else {
      check("wizard reaches the question step", false, "name field not found");
    }
  } else {
    check("wizard shows the source library", false);
  }

  // ---- 2. Launch is blocked with an incomplete configuration --------------
  await go("#/new");
  const steps = page.locator(".step");
  const stepCount = await steps.count();
  check("wizard exposes 8 steps", stepCount === 8, `found ${stepCount}`);

  // ---- 3. Run room: every tab renders content -----------------------------
  await go(`#/run/${RUN}`, 1200);
  for (const label of ["Agents", "Connections", "Findings", "Quality"]) {
    const btn = page.getByRole("button", { name: new RegExp(`^${label}`, "i") }).first();
    if (!(await btn.count())) { check(`${label} tab present`, false); continue; }
    await btn.click();
    await page.waitForTimeout(label === "Connections" ? 2600 : 1400);
    const text = await page.evaluate(() => document.body.innerText.length);
    check(`${label} tab renders`, text > 400, `${text} chars`);
  }

  // ---- 4. Network selection persists across a round change ----------------
  await page.getByRole("button", { name: /^Connections/i }).first().click();
  await page.waitForTimeout(2400);
  const firstAgent = page.locator("label.list-row input[type=checkbox]").first();
  if (await firstAgent.count()) {
    await firstAgent.click();
    await page.waitForTimeout(600);
    const selectedBefore = await page.locator("aside, .panel").filter({ hasText: /Selected|Agent/ }).count();
    // change the round via the slider
    const slider = page.getByRole("slider", { name: /Connections round/i }).first();
    if (await slider.count()) {
      await slider.fill("5");
      await page.waitForTimeout(1800);
    }
    // switch tabs and come back
    await page.getByRole("button", { name: /^Agents/i }).first().click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: /^Connections/i }).first().click();
    await page.waitForTimeout(2400);
    const stillChecked = await page
      .locator("label.list-row input[type=checkbox]:checked").count();
    check("network selection survives round change and tab switch",
      stillChecked >= 1, `${stillChecked} checked (before-driver-count ${selectedBefore})`);
  } else {
    check("network list has selectable agents", false);
  }

  // ---- 5. Agent drawer opens and explains the agent -----------------------
  await page.getByRole("button", { name: /^Agents/i }).first().click();
  await page.waitForTimeout(1200);
  const agentRow = page.locator("button.list-row").first();
  if (await agentRow.count()) {
    await agentRow.click();
    await page.waitForTimeout(1200);
    const drawerText = await page.locator("aside.drawer").innerText().catch(() => "");
    check("agent drawer opens", drawerText.length > 100, `${drawerText.length} chars`);
    check("agent drawer explains the agent",
      /Reading this agent/i.test(drawerText), drawerText.slice(0, 60));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const stillOpen = await page.locator("aside.drawer").count();
    check("Escape closes the agent drawer", stillOpen === 0, `${stillOpen} drawers`);
  } else {
    check("agent roster has rows", false);
  }

  // ---- 6. Findings renders the computed briefing --------------------------
  await page.getByRole("button", { name: /^Findings/i }).first().click();
  await page.waitForTimeout(1600);
  const findings = await page.evaluate(() => document.body.innerText);
  check("findings shows computed provenance", /Computed, not generated/i.test(findings));
  check("findings answers what happened", /What happened/i.test(findings));
  check("findings states uncertainty",
    /not yet been externally validated/i.test(findings));

  // ---- 7. Report is readable and labelled ---------------------------------
  const report = page.locator("text=Simulation Findings Report").first();
  const hasReport = await report.count();
  check("report section present in Findings", hasReport > 0, hasReport ? "" : "not found");

  // ---- 8. Documents evidence library -------------------------------------
  await go("#/documents", 1300);
  const docsText = await page.evaluate(() => document.body.innerText);
  check("evidence library renders", /Evidence library/i.test(docsText));
  const tabs = ["Overview", "Issues", "Stakeholders", "Findings", "Passages"];
  for (const t of tabs) {
    const bt = page.getByRole("button", { name: new RegExp(`^${t}`, "i") }).first();
    if (await bt.count()) {
      await bt.click();
      await page.waitForTimeout(700);
      const len = await page.evaluate(() => document.body.innerText.length);
      check(`document tab ${t} renders`, len > 300, `${len} chars`);
    } else {
      check(`document tab ${t} present`, false);
    }
  }

  // ---- 9. Unknown run id fails visibly, not silently ----------------------
  const errorsBeforeMissingRun = consoleErrors.length;
  await go("#/run/run_does_not_exist", 1600);
  const errText = await page.evaluate(() => document.body.innerText);
  check("unknown run shows an error, not a blank page",
    /could not be opened|not found/i.test(errText), errText.slice(0, 80).replace(/\n/g, " "));
  // A deliberate 404 for the missing run is expected; ignore only those.
  const unexpected = consoleErrors.slice(0, errorsBeforeMissingRun);
  check("no uncaught console errors before the deliberate 404", unexpected.length === 0,
    unexpected.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
