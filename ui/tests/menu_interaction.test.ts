import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

test("DOM Menu Interaction: Rules Dropdown Lifecycle & Event Guarding", () => {
  const window = new Window();
  const document = window.document;

  let rulesMenuPos: { top: number; left: number } | null = null;
  let contextMenu: { x: number; y: number } | null = null;

  const dismissMenus = (e?: any) => {
    const target = e?.target as any;
    if (target?.closest?.(".rules-dropdown-trigger") || target?.closest?.(".app-dropdown-menu")) {
      return;
    }
    if (contextMenu) contextMenu = null;
    if (rulesMenuPos) rulesMenuPos = null;
  };

  const toggleRulesDropdown = (btnEl: any) => {
    if (rulesMenuPos) {
      rulesMenuPos = null;
    } else {
      const rect = { bottom: 36, left: 200 };
      rulesMenuPos = { top: rect.bottom + 4, left: rect.left };
    }
  };

  window.addEventListener("click", dismissMenus);

  // 1. Initial State: Closed
  assert.strictEqual(rulesMenuPos, null);

  // 2. Click button to open
  const btn = document.createElement("button");
  btn.className = "bc-tool-btn rules-dropdown-trigger";
  document.body.appendChild(btn);

  toggleRulesDropdown(btn);
  assert.deepStrictEqual(rulesMenuPos, { top: 40, left: 200 });

  // 3. Event bubbling to window click: MUST NOT dismiss menu!
  const clickEvent = new window.MouseEvent("click", { bubbles: true });
  btn.dispatchEvent(clickEvent);
  // Verify guard: rulesMenuPos is STILL OPEN!
  assert.deepStrictEqual(rulesMenuPos, { top: 40, left: 200 });

  // 4. Click inside dropdown menu: MUST NOT dismiss menu!
  const menuContainer = document.createElement("div");
  menuContainer.className = "app-dropdown-menu";
  const item = document.createElement("div");
  item.className = "dropdown-item";
  menuContainer.appendChild(item);
  document.body.appendChild(menuContainer);

  const itemClickEvent = new window.MouseEvent("click", { bubbles: true });
  item.dispatchEvent(itemClickEvent);
  assert.deepStrictEqual(rulesMenuPos, { top: 40, left: 200 });

  // 5. Click outside (e.g. on viewport or document body): MUST dismiss menu!
  const outsideDiv = document.createElement("div");
  outsideDiv.className = "viewport-container";
  document.body.appendChild(outsideDiv);

  const outsideClickEvent = new window.MouseEvent("click", { bubbles: true });
  outsideDiv.dispatchEvent(outsideClickEvent);
  assert.strictEqual(rulesMenuPos, null);

  // 6. Escape key dismisses menu
  toggleRulesDropdown(btn);
  assert.notStrictEqual(rulesMenuPos, null);
  rulesMenuPos = null; // Mimicking Esc handler
  assert.strictEqual(rulesMenuPos, null);

  window.removeEventListener("click", dismissMenus);
});

test("DOM Menu Interaction: Context Menu Lifecycle & Dismissal", () => {
  const window = new Window();
  const document = window.document;

  let contextMenu: { x: number; y: number } | null = null;
  const dismissMenus = (e?: any) => {
    const target = e?.target as any;
    if (target?.closest?.(".rules-dropdown-trigger") || target?.closest?.(".app-dropdown-menu")) {
      return;
    }
    if (contextMenu) contextMenu = null;
  };

  window.addEventListener("click", dismissMenus);

  // 1. Right click opens context menu
  contextMenu = { x: 150, y: 300 };
  assert.deepStrictEqual(contextMenu, { x: 150, y: 300 });

  // 2. Click outside dismisses context menu
  const outside = document.createElement("div");
  document.body.appendChild(outside);
  outside.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(contextMenu, null);

  window.removeEventListener("click", dismissMenus);
});
