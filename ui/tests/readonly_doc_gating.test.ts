import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompareBackendClient, type OpenTwoWayResponse } from "../src/bridge.ts";

const DEFAULT_OPTS = {
  ignore_whitespace: false,
  ignore_case: false,
  show_only_diffs: false,
  context_lines: 3,
};

test("Readonly doc metadata: loadRealDiskFiles, replaceSideText, and swapSides track per-side readonly and doc_info", async () => {
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      cmd: string;
      args: Record<string, unknown>;
    };
    if (body.cmd === "read_text_file") {
      if (body.args.path === "/tmp/report.xlsx") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              path: "/tmp/report.xlsx",
              content: "[Sheet: Sheet1]\nA\tB\n1\t2",
              line_count: 3,
              encoding: "UTF-8",
              line_ending: "LF",
              readonly: true,
              doc_info: "XLSX · 只读 · 缓存值",
            },
          }),
          { status: 200 }
        );
      }
      if (body.args.path === "/tmp/notes.txt") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              path: "/tmp/notes.txt",
              content: "plain text line",
              line_count: 1,
              encoding: "UTF-8",
              line_ending: "LF",
              readonly: false,
              doc_info: null,
            },
          }),
          { status: 200 }
        );
      }
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
  }) as typeof fetch;

  try {
    // Mixed comparison: .xlsx (readonly) vs .txt (writable)
    const summary = await CompareBackendClient.loadRealDiskFiles(
      "test-office-mixed",
      "/tmp/report.xlsx",
      "/tmp/notes.txt",
      DEFAULT_OPTS
    );
    assert.ok(summary);
    assert.strictEqual(summary.left_readonly, true);
    assert.strictEqual(summary.right_readonly, false);
    assert.strictEqual(summary.left_doc_info, "XLSX · 只读 · 缓存值");
    assert.strictEqual(summary.right_doc_info, null);

    // Swap sides must swap readonly and doc_info
    const swapped = CompareBackendClient.swapSides("test-office-mixed");
    assert.strictEqual(swapped.left_readonly, false);
    assert.strictEqual(swapped.right_readonly, true);
    assert.strictEqual(swapped.left_doc_info, null);
    assert.strictEqual(swapped.right_doc_info, "XLSX · 只读 · 缓存值");

    // Single-side replaceSideText updates readonly and doc_info when provided
    const updated = CompareBackendClient.replaceSideText(
      "test-office-mixed",
      true,
      "DOCX content",
      {
        encoding: "UTF-8",
        lineEnding: "LF",
        readonly: true,
        docInfo: "DOCX · 只读",
      }
    );
    assert.strictEqual(updated.left_readonly, true);
    assert.strictEqual(updated.left_doc_info, "DOCX · 只读");
    assert.strictEqual(updated.right_readonly, true);
    assert.strictEqual(updated.right_doc_info, "XLSX · 只读 · 缓存值");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("OpenTwoWayResponse type includes optional readonly and doc_info fields", () => {
  const sample: OpenTwoWayResponse = {
    session_id: "s1",
    left_path: "a.docx",
    right_path: "b.txt",
    summary: CompareBackendClient.createTwoWaySession("test-open-two-way-dto", "a", "b", DEFAULT_OPTS),
    initial_slice: { start_row: 0, total_rows: 1, rows: [] },
    left_readonly: true,
    right_readonly: false,
    left_doc_info: "DOCX · 只读",
    right_doc_info: null,
  };
  assert.strictEqual(sample.left_readonly, true);
  assert.strictEqual(sample.right_readonly, false);
  assert.strictEqual(sample.left_doc_info, "DOCX · 只读");
  assert.strictEqual(sample.right_doc_info, null);
});

test("TextDiffView readonly gating: blocks save, undo/redo, merge, inline edit, and renders doc_info in statusbar", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const textSrc = fs.readFileSync(
    path.resolve(dir, "../src/views/TextDiffView.tsx"),
    "utf8"
  );
  const viewportSrc = fs.readFileSync(
    path.resolve(dir, "../src/engine/VirtualDiffViewport.tsx"),
    "utf8"
  );

  // Reactive per-side readonly combining static props and backend summary
  assert.match(
    textSrc,
    /const isLeftReadonly = createMemo\(\s*\(\) => Boolean\(props\.leftReadonly\) \|\| Boolean\(summary\(\)\.left_readonly\)\s*\)/
  );
  assert.match(
    textSrc,
    /const isRightReadonly = createMemo\(\s*\(\) => Boolean\(props\.rightReadonly\) \|\| Boolean\(summary\(\)\.right_readonly\)\s*\)/
  );

  // handleSaveSide, handleUndo, handleRedo guard against readonly
  assert.match(
    textSrc,
    /const handleSaveSide = async \(isLeft: boolean\) => \{\s*if \(isSideReadonly\(isLeft\)\) \{/
  );
  assert.match(
    textSrc,
    /const handleUndo = \(isLeft: boolean\) => \{\s*if \(isSideReadonly\(isLeft\)\) \{/
  );
  assert.match(
    textSrc,
    /const handleRedo = \(isLeft: boolean\) => \{\s*if \(isSideReadonly\(isLeft\)\) \{/
  );

  // Toolbar save button disabled when focused side is readonly
  assert.match(textSrc, /disabled=\{isFocusedReadonly\(\)\}/);

  // Statusbar renders left_doc_info / right_doc_info in place of encoding/line_ending
  assert.match(textSrc, /summary\(\)\.left_doc_info \|\| `\$\{summary\(\)\.left_encoding\}\/\$\{summary\(\)\.left_line_ending\}`/);
  assert.match(textSrc, /summary\(\)\.right_doc_info \|\| `\$\{summary\(\)\.right_encoding\}\/\$\{summary\(\)\.right_line_ending\}`/);

  // VirtualDiffViewport receives reactive leftReadonly/rightReadonly
  assert.match(textSrc, /leftReadonly=\{isLeftReadonly\(\)\}/);
  assert.match(textSrc, /rightReadonly=\{isRightReadonly\(\)\}/);

  // VirtualDiffViewport gates inline editor dblclick and gutter merge buttons
  assert.match(viewportSrc, /onDblClick=\{\(\) => \{\s*if \(props\.leftReadonly\) return;/);
  assert.match(viewportSrc, /onDblClick=\{\(\) => \{\s*if \(props\.rightReadonly\) return;/);
  assert.match(viewportSrc, /<Show when=\{!props\.rightReadonly\}>\s*<button\s+class="gutter-copy-btn copy-right"/);
  assert.match(viewportSrc, /<Show when=\{!props\.leftReadonly\}>\s*<button\s+class="gutter-copy-btn copy-left"/);
});
