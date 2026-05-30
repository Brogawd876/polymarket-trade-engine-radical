import { getSlotTS, setMarketOffset } from "../utils/slot.ts";

function probe(label: string, mockTimestamp: number) {
  // `getSlotTS()` internally uses `Date.now() + _nowOffsetMs`.
  // We can force it to use `mockTimestamp` by setting offset exactly.
  const offset = mockTimestamp - Date.now();
  // We can't easily mock Date.now() without a test runner or overriding global,
  // but wait, `setMarketOffset(targetSec.toString())` aligns the virtual now offset!
  // Actually, setMarketOffset just aligns to the slot, it doesn't set exact arbitrary ms.
  // Wait, `_nowOffsetMs = parseInt(arg) * interval * 1000;` or `_nowOffsetMs = slotStart * 1000 - Date.now()`.
  
  // Let's just override Date.now
  const originalNow = Date.now;
  Date.now = () => mockTimestamp;

  try {
    const slot0 = getSlotTS(0);
    const slot1 = getSlotTS(1);
    console.log(`\n--- ${label} ---`);
    console.log(`Mock Time: ${mockTimestamp} (epoch)`);
    console.log(`Current Slot (offset 0): [${slot0.startTime}, ${slot0.endTime})`);
    console.log(`Next Slot    (offset 1): [${slot1.startTime}, ${slot1.endTime})`);
  } finally {
    Date.now = originalNow;
  }
}

function main() {
  const BASE_TIMESTAMP = 1772568900 * 1000; // 5m aligned
  const slotStart = BASE_TIMESTAMP + (5 * 60 * 1000); // the next slot start
  
  probe("1 second before rollover", slotStart - 1000);
  probe("Exactly at rollover boundary", slotStart);
  probe("1 second after rollover", slotStart + 1000);
}

main();
