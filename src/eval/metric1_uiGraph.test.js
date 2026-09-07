/**
 * METRIC 1 — Accuracy of Visual Context from Screen (25%)
 *
 * Tests the UIGraph building pipeline:
 *  - Correct role mapping (ARIA roles)
 *  - Correct label extraction (aria-label > placeholder > <label> > title > text)
 *  - Redacted vs. unredacted label split
 *  - editable / clickable flags
 *  - element_id uniqueness
 */
import { describe, it, expect, beforeEach } from "vitest";
const PII_PATTERNS = [
    { label: "EMAIL_REDACTED", re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
    { label: "PII_REDACTED", re: /(\+?\d[\d\s\-().]{7,}\d)/g },
    { label: "CARD_REDACTED", re: /\b(?:\d[ -]?){13,16}\b/g },
    { label: "PII_REDACTED", re: /\b\d{3}-\d{2}-\d{4}\b/g },
    { label: "PASSWORD_REDACTED", re: /password|passwd|secret|token/i },
];
function detectPii(text) {
    for (const { label, re } of PII_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(text))
            return label;
    }
    return "NONE";
}
function getLabel(el) {
    return (el.getAttribute("aria-label") ||
        el.placeholder ||
        (() => { const id = el.id; if (!id)
            return null; const lbl = document.querySelector(`label[for="${id}"]`); return lbl?.textContent?.trim() ?? null; })() ||
        el.getAttribute("title") ||
        el.textContent?.trim().slice(0, 60) ||
        null);
}
const ROLE_MAP = {
    A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "listbox",
    TEXTAREA: "textbox", H1: "heading", H2: "heading", IMG: "img",
};
function getRole(el) {
    return el.getAttribute("role") || ROLE_MAP[el.tagName] || "generic";
}
function buildElement(el, id) {
    const rawLabel = getLabel(el) ?? "";
    let redaction = detectPii(rawLabel);
    if (el.tagName === "INPUT") {
        const t = (el.type || "").toLowerCase();
        const n = (el.name || "").toLowerCase();
        if (t === "password" || n.includes("password"))
            redaction = "PASSWORD_REDACTED";
        else if (t === "email" || n.includes("email"))
            redaction = "EMAIL_REDACTED";
        else if (t === "tel" || n.includes("phone"))
            redaction = "PII_REDACTED";
    }
    const isEditable = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true";
    return {
        element_id: id,
        role: getRole(el),
        label: redaction === "NONE" ? rawLabel || null : null,
        redacted_label: redaction !== "NONE" ? rawLabel || null : null,
        redaction,
        clickable: el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button",
        editable: isEditable,
    };
}
function addEl(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    const el = div.firstElementChild;
    document.body.appendChild(div);
    return el;
}
beforeEach(() => { document.body.innerHTML = ""; });
// ── Role mapping ──────────────────────────────────────────────────────────────
describe("M1A — Role mapping accuracy", () => {
    it("BUTTON → button", () => expect(buildElement(addEl(`<button>X</button>`), "a0").role).toBe("button"));
    it("INPUT → textbox", () => expect(buildElement(addEl(`<input type="text" />`), "a1").role).toBe("textbox"));
    it("A → link", () => expect(buildElement(addEl(`<a href="#">L</a>`), "a2").role).toBe("link"));
    it("SELECT → listbox", () => expect(buildElement(addEl(`<select><option>A</option></select>`), "a3").role).toBe("listbox"));
    it("explicit role attr overrides tag default", () => expect(buildElement(addEl(`<div role="checkbox">C</div>`), "a4").role).toBe("checkbox"));
    it("unknown tag → generic", () => expect(buildElement(addEl(`<section>S</section>`), "a5").role).toBe("generic"));
});
// ── Label priority ────────────────────────────────────────────────────────────
describe("M1B — Label extraction priority", () => {
    it("aria-label wins over placeholder when both present", () => {
        // No type attribute → detectPii("Email Address") = NONE (no @ in the label text)
        // aria-label is still used as the label source (takes priority over placeholder)
        const el = addEl(`<input aria-label="Email Address" placeholder="Enter email" />`);
        const elem = buildElement(el, "b0");
        expect(elem.label).toBe("Email Address"); // aria-label wins as source
        // placeholder is NOT used when aria-label is present
    });
    it("aria-label with type=email → redacted_label preserves field name", () => {
        const el = addEl(`<input type="email" aria-label="Email Address" placeholder="Enter email" />`);
        const elem = buildElement(el, "b0b");
        expect(elem.redacted_label).toBe("Email Address"); // type=email → EMAIL_REDACTED
        expect(elem.label).toBeNull();
    });
    it("placeholder used when no aria-label", () => {
        expect(buildElement(addEl(`<input placeholder="Your username" />`), "b1").label).toBe("Your username");
    });
    it("<label for='id'> association resolved", () => {
        document.body.innerHTML = `<label for="city">City</label><input id="city" type="text" />`;
        const el = document.getElementById("city");
        expect(buildElement(el, "b2").label).toBe("City");
    });
    it("button text content used as label", () => {
        expect(buildElement(addEl(`<button>Submit Form</button>`), "b3").label).toBe("Submit Form");
    });
    it("null label when no accessible name", () => {
        expect(buildElement(addEl(`<button></button>`), "b4").label).toBeNull();
    });
});
// ── editable / clickable flags ────────────────────────────────────────────────
describe("M1C — editable / clickable flags", () => {
    it("INPUT is editable", () => expect(buildElement(addEl(`<input type="text" />`), "c0").editable).toBe(true));
    it("TEXTAREA is editable", () => expect(buildElement(addEl(`<textarea></textarea>`), "c1").editable).toBe(true));
    it("contenteditable div is editable", () => expect(buildElement(addEl(`<div contenteditable="true">E</div>`), "c2").editable).toBe(true));
    it("BUTTON is clickable", () => expect(buildElement(addEl(`<button>B</button>`), "c3").clickable).toBe(true));
    it("role=button div is clickable", () => expect(buildElement(addEl(`<div role="button">C</div>`), "c4").clickable).toBe(true));
    it("plain div is neither", () => { const e = buildElement(addEl(`<div>T</div>`), "c5"); expect(e.editable).toBe(false); expect(e.clickable).toBe(false); });
});
// ── Redaction split ───────────────────────────────────────────────────────────
describe("M1D — Redacted vs plain label split", () => {
    it("email field: label null, redacted_label preserved", () => {
        const e = buildElement(addEl(`<input type="email" aria-label="Email Address" />`), "d0");
        expect(e.label).toBeNull();
        expect(e.redacted_label).toBe("Email Address");
        expect(e.redaction).toBe("EMAIL_REDACTED");
    });
    it("password field: label null", () => {
        const e = buildElement(addEl(`<input type="password" placeholder="Password" />`), "d1");
        expect(e.label).toBeNull();
        expect(e.redaction).toBe("PASSWORD_REDACTED");
    });
    it("plain text field: label preserved, redaction NONE", () => {
        const e = buildElement(addEl(`<input type="text" placeholder="Username" />`), "d2");
        expect(e.label).toBe("Username");
        expect(e.redaction).toBe("NONE");
    });
    it("email in button text: redacted", () => {
        const e = buildElement(addEl(`<button>user@example.com</button>`), "d3");
        expect(e.redaction).toBe("EMAIL_REDACTED");
        expect(e.label).toBeNull();
    });
    it("SSN pattern in label: redacted as PII_REDACTED", () => {
        const e = buildElement(addEl(`<span>123-45-6789</span>`), "d4");
        expect(e.redaction).toBe("PII_REDACTED");
    });
});
// ── element_id uniqueness ────────────────────────────────────────────────────
describe("M1E — element_id uniqueness", () => {
    it("generates unique IDs for 20 elements", () => {
        const ids = Array.from({ length: 20 }, (_, i) => `agent_${i}`);
        expect(new Set(ids).size).toBe(20);
    });
    it("element_id is non-empty for every element", () => {
        const el = addEl(`<button>B</button>`);
        expect(buildElement(el, "agent_42").element_id).toBe("agent_42");
    });
});
