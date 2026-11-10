import { chromium } from "playwright-core";
import { serve } from "./serve.mjs";
const server = await serve(0); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
await page.goto(base + "/?delay=2500");
await page.waitForFunction(() => document.getElementById("page").contentWindow?.__b42);
const f = page.frames().find((fr) => fr.url().endsWith("/harness/page.html"));
await f.waitForFunction(() => document.documentElement.hasAttribute("data-b42-review"));
const c = async (sel, shift) => { const b = await f.locator(sel).first().boundingBox(); if (shift) await page.keyboard.down("Shift"); await page.mouse.click(b.x+b.width/2, b.y+b.height/2); if (shift) await page.keyboard.up("Shift"); };
const note = async (t) => { await page.keyboard.type(t); await page.keyboard.press("Enter"); await page.waitForTimeout(120); };
await c("#menu"); await note("busy and not needed on mobile, hide in the menu");
await c(".hero h1"); await note("copy v1 -> copy v2");
await c('nav a[href="#features"]'); await c('nav a[href="#pricing"]', true); await note("same weight as the logo");
await page.waitForTimeout(2700);
// draft: alt-drawn line across the card headings, then type without sending
const hs = await Promise.all([1,2,3].map(i => f.locator(`#cards article:nth-of-type(${i}) h3`).boundingBox()));
const y = hs[0].y + hs[0].height/2 + 2;
await page.keyboard.down("Alt"); await page.mouse.move(hs[0].x - 6, y); await page.mouse.down();
for (let i = 0; i <= 30; i++) { const x = hs[0].x - 6 + (hs[2].x + hs[2].width + 12 - hs[0].x) * i/30; await page.mouse.move(x, y + Math.sin(i/3)*3); }
await page.mouse.up(); await page.keyboard.up("Alt");
await page.keyboard.type("pl-8 on all three");
const b = await f.locator(".toolbar button:nth-child(3)").boundingBox(); await page.mouse.move(b.x + 10, b.y + 8);
await page.waitForTimeout(300);
await page.screenshot({ path: new URL("../docs/harness.png", import.meta.url).pathname });
await browser.close(); server.close();
