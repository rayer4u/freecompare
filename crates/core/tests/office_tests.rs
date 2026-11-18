use freecompare_core::{
    diff::{three_way::ThreeWaySession, two_way::{DiffOptions, TwoWaySession}},
    office::{
        self,
        excel::{extract_workbook_snapshot, render_workbook_text, ExcelLimits},
        word::{extract_docx_with_limits, wrap_text_line, DocxLimits},
        OfficeError, OfficeKind, OLE2_MAGIC,
    },
};
use std::fs;
use std::io::{Cursor, Write};
use tempfile::tempdir;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

fn build_synthetic_xlsx(sheet1_rows: &[(&str, &str)], sheet2_val: &str) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default();

        zip.start_file("[Content_Types].xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
        )
        .unwrap();

        zip.start_file("_rels/.rels", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        )
        .unwrap();

        zip.start_file("xl/workbook.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Details" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"#,
        )
        .unwrap();

        zip.start_file("xl/_rels/workbook.xml.rels", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#,
        )
        .unwrap();

        let mut s1 = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#,
        );
        for (idx, (a, b)) in sheet1_rows.iter().enumerate() {
            let r = idx + 1;
            s1.push_str(&format!(
                r#"<row r="{r}"><c r="A{r}" t="inlineStr"><is><t>{a}</t></is></c><c r="B{r}" t="inlineStr"><is><t>{b}</t></is></c></row>"#
            ));
        }
        s1.push_str("</sheetData></worksheet>");

        zip.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
        zip.write_all(s1.as_bytes()).unwrap();

        let s2 = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>{sheet2_val}</t></is></c><c r="B1"><f>1+1</f><v>2</v></c></row>
</sheetData></worksheet>"#
        );
        zip.start_file("xl/worksheets/sheet2.xml", opts).unwrap();
        zip.write_all(s2.as_bytes()).unwrap();

        zip.finish().unwrap();
    }
    buf.into_inner()
}

fn build_synthetic_docx(document_xml: &str) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default();
        zip.start_file("word/document.xml", opts).unwrap();
        zip.write_all(document_xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    buf.into_inner()
}

#[test]
fn test_xlsx_extraction_and_two_way_diff() {
    let dir = tempdir().unwrap();
    let left_path = dir.path().join("left.xlsx");
    let right_path = dir.path().join("right.xlsx");

    let left_bytes = build_synthetic_xlsx(&[("Item", "Value"), ("Line1\nLine2", "100")], "Alpha");
    let right_bytes = build_synthetic_xlsx(&[("Item", "Value"), ("Line1\nLine2", "200")], "Alpha");

    fs::write(&left_path, &left_bytes).unwrap();
    fs::write(&right_path, &right_bytes).unwrap();

    let session = TwoWaySession::from_files(&left_path, &right_path, DiffOptions::default()).unwrap();
    assert!(session.left_readonly);
    assert!(session.right_readonly);
    assert_eq!(session.left_doc_info.as_deref(), Some("XLSX · 只读 · 缓存值"));
    assert_eq!(session.right_doc_info.as_deref(), Some("XLSX · 只读 · 缓存值"));

    let left_text = session.left.full_text();
    assert!(left_text.contains("[Sheet: Summary]"));
    assert!(left_text.contains("Line1\\nLine2\t100"));
    assert!(left_text.contains("[Sheet: Details]"));
    assert!(left_text.contains("Alpha\t2"));

    assert_eq!(session.summary().hunks.len(), 1);
}

#[test]
fn test_excel_truncation_limits() {
    let bytes = build_synthetic_xlsx(
        &[("R1", "V1"), ("R2", "V2"), ("R3", "V3"), ("R4", "V4")],
        "DetailsVal",
    );
    let snapshot = extract_workbook_snapshot(
        &bytes,
        ExcelLimits {
            max_sheets: 10,
            max_total_rows: 2,
            max_total_cells: 1000,
        },
    )
    .unwrap();
    assert!(snapshot.truncated);
    assert_eq!(snapshot.sheets.len(), 1);
    assert_eq!(snapshot.sheets[0].rows.len(), 2);
    let rendered = render_workbook_text(&snapshot);
    assert!(rendered.contains("[已截断:"));
}

#[test]
fn test_docx_extraction_revisions_tables_and_wrapping() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Project Overview</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Hello </w:t></w:r>
      <w:del><w:r><w:delText>old deleted text </w:delText></w:r></w:del>
      <w:ins><w:r><w:t>new inserted </w:t></w:r></w:ins>
      <w:r><w:t>world.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>ColA</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>ColB</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>123</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>456</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;

    let bytes = build_synthetic_docx(xml);
    let doc = office::extract_office_bytes(&bytes, "docx").unwrap();
    assert_eq!(doc.kind, OfficeKind::WordDocx);
    assert_eq!(doc.doc_info, "DOCX · 只读");
    assert!(!doc.truncated);

    assert!(doc.text.contains("# Project Overview"));
    assert!(doc.text.contains("Hello new inserted world."));
    assert!(!doc.text.contains("old deleted text"));
    assert!(doc.text.contains("| ColA | ColB |"));
    assert!(doc.text.contains("| 123 | 456 |"));

    // Controlled wrapping around ~100 chars
    let long = "这是一个非常长的段落用于测试中文标点符号处的自动折行逻辑，确保在超过一百个字符的时候能够平滑切分；同时不会在字符中间截断导致乱码。接下来还有一些补充说明文字，用来验证多段折行输出是否符合预期。";
    let wrapped = wrap_text_line(long, 50);
    assert!(wrapped.len() >= 2);
    assert!(wrapped.iter().all(|l| l.chars().count() <= 50));
}

#[test]
fn test_docx_zip_bomb_truncation() {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
    );
    for i in 0..200 {
        xml.push_str(&format!("<w:p><w:r><w:t>Paragraph number {i}</w:t></w:r></w:p>"));
    }
    xml.push_str("</w:body></w:document>");

    let bytes = build_synthetic_docx(&xml);
    let doc = extract_docx_with_limits(
        &bytes,
        DocxLimits {
            max_xml_bytes: 512,
            max_lines: 1000,
            max_chars: 100_000,
            wrap_width: 100,
        },
    )
    .unwrap();
    assert!(doc.truncated);
    assert!(doc.text.contains("[已截断:"));
}

#[test]
fn test_legacy_doc_and_three_way_rejection() {
    let dir = tempdir().unwrap();
    let doc_path = dir.path().join("legacy.doc");
    fs::write(&doc_path, OLE2_MAGIC).unwrap();

    let err = office::load_office_document(doc_path.to_str().unwrap()).unwrap_err();
    assert!(matches!(err, OfficeError::LegacyDocUnsupported));
    assert!(err.to_string().contains(".docx"));

    let txt_path = dir.path().join("plain.txt");
    fs::write(&txt_path, "hello").unwrap();

    let three_err = ThreeWaySession::from_files(&doc_path, &txt_path, &txt_path, None)
        .err()
        .unwrap();
    assert!(three_err.to_string().contains("三向合并"));
}

#[test]
fn test_extract_extension_preserves_windows_unc_prefix() {
    let win_unc = r"\\?\C:\Users\runner\AppData\Local\Temp\left.docx";
    assert_eq!(office::extract_extension(win_unc).as_deref(), Some("docx"));
    assert!(office::is_office_path(win_unc));

    let sftp_query = "sftp://host/path/sheet.xlsx?readonly=1#top";
    assert_eq!(
        office::extract_extension(sftp_query).as_deref(),
        Some("xlsx")
    );
    assert!(office::is_office_path(sftp_query));
}
