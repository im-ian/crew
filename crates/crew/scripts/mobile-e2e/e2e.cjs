// Phone E2E against a real daemon + web server in an isolated CREW_HOME.
// Run it through run.sh, which builds the folder this reads (E2E_DIR).
const { webkit, devices } = require("playwright-core");
const { execSync, spawn } = require("child_process");
const E = process.env.E2E_DIR;
const PORT = process.env.E2E_PORT || "47899";
if (!E) throw new Error("run this through run.sh");
const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function step(name, fn) {
  try {
    await fn();
    results.push(["ok", name]);
    log("ok  ", name);
  } catch (e) {
    results.push(["FAIL", name, String(e).split("\n")[0].slice(0, 200)]);
    log("FAIL", name, String(e).split("\n")[0].slice(0, 200));
  }
}
const shot = (page, n) => page.screenshot({ path: `${E}/${n}.png` });
const newCode = () => JSON.parse(execSync(`python3 ${JSON.stringify(__dirname + "/pair.py")} ${JSON.stringify(E + "/home")}`).toString()).code;

(async () => {
  // Headless: no window opens. PW_WEBKIT names a WebKit build when the one
  // this playwright-core expects is not installed.
  const browser = await webkit.launch(process.env.PW_WEBKIT ? { executablePath: process.env.PW_WEBKIT } : {});
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));

  await step("짝짓기 화면이 뜬다", async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("#pair-code");
    await shot(page, "01-pair");
  });
  await step("틀린 코드는 안내가 나온다", async () => {
    await page.fill("#pair-code", "000000");
    await page.click(".pair-submit");
    await page.waitForSelector(".pair-error");
    await shot(page, "02-pair-wrong");
  });
  await step("맞는 코드로 짝지으면 앱이 열린다", async () => {
    await page.fill("#pair-code", newCode());
    await page.click(".pair-submit");
    await page.waitForSelector(".composer-input");
    await page.waitForTimeout(1500);
    await shot(page, "03-app");
  });
  await step("봇 목록(서랍)", async () => {
    await page.tap(".head-rail");
    await page.waitForSelector(".rail-row:has-text('에코')");
    await page.waitForTimeout(500);
    await shot(page, "04-bot-list");
  });
  await step("대화 열기", async () => {
    await page.click(".rail-row:has-text('에코')");
    await page.waitForTimeout(800);
    const stayed = await page.evaluate(() => document.querySelector(".app")?.classList.contains("rail-open"));
    if (stayed) {
      await shot(page, "05a-drawer-stayed-open");
      // Known (#338): tapping the chat already open keeps the drawer. Close it to go on.
      await page.mouse.click(370, 400);
      await page.waitForTimeout(500);
    }
    await shot(page, "05-chat-open");
    if (stayed) throw new Error("tapping the open chat left the drawer open (handed to the layout lane)");
  });
  await step("메시지 보내기 → 답 표시", async () => {
    await page.click(".composer-input");
    await page.keyboard.type("휴대폰에서 안녕");
    await page.click("button[aria-label='보내기']");
    await page.waitForSelector("text=받았어요: 휴대폰에서 안녕", { timeout: 20000 });
    await page.waitForTimeout(500);
    await shot(page, "06-reply");
  });
  await step("노트북 표시 설정(글자 크기·내 이름)을 따른다", async () => {
    const scale = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chat-scale").trim());
    if (!scale) throw new Error("no --chat-scale from the laptop's large text");
    // A phone has no reply chip beside the message (#345): a held finger
    // opens the menu (#341). Playwright cannot hold a touch, so this sends
    // the event the hold sends, on the user's own message.
    const held = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".bubble-row")].filter((r) => r.innerText.includes("휴대폰에서 안녕"));
      const host = rows[0];
      if (!host) return false;
      const box = host.getBoundingClientRect();
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.x + 30, clientY: box.y + 10, view: window });
      ev.crewLongPress = true;
      host.dispatchEvent(ev);
      return true;
    });
    if (!held) throw new Error("no message of the user's to hold");
    await page.click(".ctx button:has-text('답장')");
    await page.waitForTimeout(300);
    const named = await page.isVisible("text=대호에게 답장");
    await shot(page, "07-reply-to-me");
    if (!named) throw new Error("the reply quote did not say 대호");
    await page.keyboard.press("Escape");
    const x = page.locator("button[aria-label='답장 취소']");
    if (await x.count()) await x.first().click();
  });
  await step("사진 첨부 → 보내기 → 사진 표시", async () => {
    await page.setInputFiles(".composer input[type=file]", `${E}/fixtures/photo.png`);
    await page.waitForSelector(".attach-photo img");
    await shot(page, "08-attach-preview");
    await page.click(".composer-input");
    await page.keyboard.type("사진");
    await page.click("button[aria-label='보내기']");
    await page.waitForSelector("text=/받았어요: .*사진/", { timeout: 20000 });
    await page.waitForTimeout(1500);
    const imgs = await page.evaluate(() => [...document.querySelectorAll(".thread img")].map((i) => ({ src: i.getAttribute("src"), w: i.naturalWidth })));
    const ok = imgs.find((i) => i.src && i.src.startsWith("/api/file") && i.w > 0);
    await shot(page, "09-photo-sent");
    if (!ok) throw new Error("no photo loaded from /api/file: " + JSON.stringify(imgs.slice(-3)));
  });
  await step("질문 카드 답하기", async () => {
    const said = () => page.evaluate(() => (document.querySelector(".thread")?.innerText.match(/고른 것:[^\n]*/g) ?? []));
    const before = (await said()).length;
    await page.click(".composer-input");
    await page.keyboard.type("카드 보여줘");
    await page.click("button[aria-label='보내기']");
    // Only the card still waiting for an answer: an answered card shows its pick too.
    const opt = page.locator(".choice-card.is-pending .choice-option:has-text('왼쪽')");
    await opt.waitFor({ timeout: 20000 });
    await shot(page, "10-card");
    await opt.tap();
    await page.waitForTimeout(300);
    if (!(await opt.evaluate((b) => b.classList.contains("is-on")))) throw new Error("the tapped option is not marked");
    await shot(page, "10b-card-picked");
    await page.locator(".choice-card.is-pending .choice-submit").tap();
    await page.waitForFunction((n) => (document.querySelector(".thread")?.innerText.match(/고른 것:[^\n]*/g) ?? []).length > n, before, { timeout: 20000 });
    const last = (await said()).pop();
    await page.waitForTimeout(500);
    await shot(page, "11-card-answered");
    if (!last.includes("왼쪽")) throw new Error("the bot got: " + last);
  });
  await step("노트북이 꺼지면 배너", async () => {
    execSync(`CREW_HOME=${JSON.stringify(E + "/home")} ${JSON.stringify(E + "/bin/crew")} stop`, { stdio: "ignore" });
    await page.waitForSelector(".conn-banner", { timeout: 20000 });
    const text = await page.textContent(".conn-banner");
    if (!text.includes("노트북")) throw new Error("banner: " + text);
    await shot(page, "12-laptop-down");
  });
  await step("끊긴 동안 첨부하면 첨부 줄에 안내", async () => {
    await page.setInputFiles(".composer input[type=file]", `${E}/fixtures/photo.png`);
    await page.waitForSelector(".attach-error", { timeout: 30000 });
    await shot(page, "13-upload-offline");
  });
  await step("노트북이 돌아오면 배너가 사라진다", async () => {
    spawn(`${__dirname}/start-daemon.sh`, { detached: true, stdio: ["ignore", require("fs").openSync(`${E}/daemon.log`, "a"), require("fs").openSync(`${E}/daemon.log`, "a")] }).unref();
    await page.waitForSelector(".conn-banner", { state: "detached", timeout: 30000 });
    await shot(page, "14-back");
  });
  console.log(JSON.stringify(results, null, 1));
  require("fs").writeFileSync(`${E}/results.json`, JSON.stringify(results, null, 1));
  process.exit(results.every((r) => r[0] === "ok") ? 0 : 1);
})();
