import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Wheel } from "../components/planisphere/Wheel";
import { typicalWeekSectors, weekSectors } from "../lib/planisphere/sessions";
import { LIQUIDATIONS } from "../lib/liquidations";

const render = (extra: Partial<Parameters<typeof Wheel>[0]> = {}) =>
  renderToString(
    <svg viewBox="0 0 760 720">
      <Wheel id="t" cx={380} cy={360} R={282} rotation={0} sectors={typicalWeekSectors()} liquidations={LIQUIDATIONS} {...extra} />
    </svg>,
  );

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("<Wheel> server render", () => {
  it("draws one mark per liquidation, typed by group", () => {
    const html = render();
    expect(count(html, /data-star="/g)).toBe(121);
    expect(count(html, /data-group="organic"/g)).toBe(33);
    expect(count(html, /data-group="seed"/g)).toBe(87);
    expect(count(html, /data-group="loan"/g)).toBe(1);
  });

  it("draws the 87 tripwire rows hollow and dim, never as filled stars", () => {
    const html = render();
    const seeds = html.match(/<g data-star="\d+" data-group="seed">.*?<\/g>/g) ?? [];
    expect(seeds).toHaveLength(87);
    for (const g of seeds) {
      expect(g).toContain('fill="none" stroke="#8fa3c9" stroke-width="1" opacity="0.75"');
      expect(g).not.toContain('fill="#fff6d8"');
    }
  });

  it("draws the session ring from the calendar: five regular sessions and an empty weekend", () => {
    const html = render();
    expect(count(html, /fill="#e6ecf7"/g)).toBe(5);
    expect(count(html, /fill="#b5c4e2"/g)).toBe(10);
    expect(count(html, /fill="#8399c8"/g)).toBe(6);
    expect(count(html, /fill="#5f78b2"/g)).toBe(0);
    expect(count(html, /stroke-dasharray="3 4"/g)).toBe(5); // first-90-minute wedges
    expect(html).toContain(">MONDAY<");
    expect(html).toContain(">SUNDAY<");
  });

  it("marks a holiday on the ring and drops that day's daylight", () => {
    const html = render({ sectors: weekSectors(1795453200).sectors }); // Thanksgiving week 2026
    expect(count(html, /fill="#e6ecf7"/g)).toBe(4);
    expect(count(html, /fill="#5f78b2"/g)).toBe(1);
    expect(count(html, /stroke-dasharray="3 4"/g)).toBe(4);
  });

  it("in link mode every star opens BscScan and only one star is in the tab order", () => {
    const html = render({ links: true, activeStar: 5 });
    expect(count(html, /<a href="https:\/\/bscscan\.com\/tx\/0x[0-9a-f]{64}" target="_blank" rel="noopener noreferrer"/g)).toBe(121);
    expect(count(html, /tabindex="0"/g)).toBe(1);
    expect(html).toMatch(/data-star="5" data-group="organic" tabindex="0"/);
    expect(count(html, /aria-label="[^"]+repaid, (organic borrower|tripwire test address|bStock was the loan asset)"/g)).toBe(121);
  });

  it("compact mode shortens the rim labels and can hide graticule and wedges", () => {
    const html = render({ compact: true, money: false, wedges: false });
    expect(html).toContain(">MON<");
    expect(html).not.toContain(">MONDAY<");
    expect(count(html, /stroke-dasharray/g)).toBe(0);
  });
});
