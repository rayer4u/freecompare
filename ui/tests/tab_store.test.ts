import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "solid-js/store";

interface WorkspaceTab {
  id: string;
  title: string;
  kind: "home" | "two_way" | "folder" | "three_way";
  leftPath?: string;
  rightPath?: string;
}

test("SolidJS createStore preserves tab object reference identity on title mutation", () => {
  const [tabs, setTabs] = createStore<WorkspaceTab[]>([
    { id: "tab-home", title: "🏠 新建会话", kind: "home" },
    { id: "tab-two_way-1", title: "⇄ App.tsx", kind: "two_way" },
  ]);

  const originalTabRef = tabs[1];

  // Update tab title using index-based fine-grained mutation
  const idx = tabs.findIndex((t) => t.id === "tab-two_way-1");
  assert.notStrictEqual(idx, -1);

  setTabs(idx, "title", "⇄ App.tsx ↔ bridge.ts");

  // Title was updated
  assert.strictEqual(tabs[1].title, "⇄ App.tsx ↔ bridge.ts");

  // CRITICAL REGRESSION TEST:
  // The tab proxy reference MUST remain strictly identical.
  // If this fails, Solid's `<For each={tabs}>` unmounts and remounts the view,
  // creating an infinite re-render / window flashing loop!
  assert.strictEqual(
    tabs[1],
    originalTabRef,
    "Tab object reference must not change when updating title in createStore!"
  );
});

test("Updating tab title with identical value is a no-op", () => {
  let changeCount = 0;
  const [tabs, setTabs] = createStore<WorkspaceTab[]>([
    { id: "tab-1", title: "⇄ App.tsx", kind: "two_way" },
  ]);

  const updateTabTitle = (tabId: string, newTitle: string) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx !== -1 && tabs[idx].title !== newTitle) {
      changeCount++;
      setTabs(idx, "title", newTitle);
    }
  };

  updateTabTitle("tab-1", "⇄ App.tsx"); // same title
  assert.strictEqual(changeCount, 0, "No mutation should occur if title is identical");

  updateTabTitle("tab-1", "⇄ NewTitle.tsx");
  assert.strictEqual(changeCount, 1, "Mutation occurs on actual title change");
  assert.strictEqual(tabs[0].title, "⇄ NewTitle.tsx");
});

test("View title reporter deduplicates identical path notifications", () => {
  let reportedCount = 0;
  let lastReportedTitle = "";

  const reportTitleChange = (shortTitle: string) => {
    if (shortTitle && shortTitle !== lastReportedTitle) {
      lastReportedTitle = shortTitle;
      reportedCount++;
    }
  };

  // First load
  reportTitleChange("App.tsx ↔ bridge.ts");
  assert.strictEqual(reportedCount, 1);
  assert.strictEqual(lastReportedTitle, "App.tsx ↔ bridge.ts");

  // Redundant reload with same files (e.g. onMount or options change)
  reportTitleChange("App.tsx ↔ bridge.ts");
  assert.strictEqual(reportedCount, 1, "Must not report duplicate title");

  // Changed file
  reportTitleChange("main.rs ↔ lib.rs");
  assert.strictEqual(reportedCount, 2);
  assert.strictEqual(lastReportedTitle, "main.rs ↔ lib.rs");
});
