use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Plain,
    Keyword,
    String,
    Comment,
    Number,
    Type,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyntaxToken {
    pub text: String,
    pub kind: TokenKind,
}

const COMMON_KEYWORDS: &[&str] = &[
    "fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "match", "if",
    "else", "for", "while", "loop", "return", "async", "await", "const", "static", "where",
    "function", "var", "class", "interface", "type", "import", "export", "from", "default",
    "try", "catch", "finally", "throw", "new", "delete", "typeof", "instanceof", "def", "lambda",
    "pass", "yield", "with", "as", "package", "func", "go", "defer", "select", "chan", "map",
    "switch", "case", "break", "continue", "true", "false", "null", "None", "Some", "Ok", "Err",
];

/// Fast incremental line tokenizer for viewport slices.
pub fn highlight_line(line: &str, _ext: &str) -> Vec<SyntaxToken> {
    if line.is_empty() {
        return Vec::new();
    }

    let trimmed = line.trim_start();
    if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("--") {
        return vec![SyntaxToken {
            text: line.to_string(),
            kind: TokenKind::Comment,
        }];
    }

    let mut tokens = Vec::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        // Line comment mid-line
        if ch == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            let rest: String = chars[i..].iter().collect();
            tokens.push(SyntaxToken {
                text: rest,
                kind: TokenKind::Comment,
            });
            break;
        }

        // String literal
        if ch == '"' || ch == '\'' || ch == '`' {
            let quote = ch;
            let start = i;
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' {
                    i += 2;
                    continue;
                }
                if chars[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
            let s: String = chars[start..i.min(chars.len())].iter().collect();
            tokens.push(SyntaxToken {
                text: s,
                kind: TokenKind::String,
            });
            continue;
        }

        // Identifier or Keyword
        if ch.is_alphabetic() || ch == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let kind = if COMMON_KEYWORDS.contains(&word.as_str()) {
                TokenKind::Keyword
            } else if word.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
                TokenKind::Type
            } else {
                TokenKind::Plain
            };
            push_token(&mut tokens, word, kind);
            continue;
        }

        // Numbers
        if ch.is_ascii_digit() {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_hexdigit() || chars[i] == '.' || chars[i] == 'x' || chars[i] == '_') {
                i += 1;
            }
            let num: String = chars[start..i].iter().collect();
            push_token(&mut tokens, num, TokenKind::Number);
            continue;
        }

        push_token(&mut tokens, ch.to_string(), TokenKind::Plain);
        i += 1;
    }

    tokens
}

fn push_token(tokens: &mut Vec<SyntaxToken>, text: String, kind: TokenKind) {
    if kind == TokenKind::Plain {
        if let Some(last) = tokens.last_mut() {
            if last.kind == TokenKind::Plain {
                last.text.push_str(&text);
                return;
            }
        }
    }
    tokens.push(SyntaxToken { text, kind });
}
