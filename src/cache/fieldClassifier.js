/**
 * src/cache/fieldClassifier.ts
 *
 * Derives a consistent semantic key for a given input field based on
 * its DOM properties and existing PII classifications.
 */
const NORMALIZE_MAP = {
    // Email
    "email": "email",
    "e-mail": "email",
    "email address": "email",
    // Phone
    "tel": "phone",
    "phone": "phone",
    "mobile": "phone",
    "telephone": "phone",
    "cell": "phone",
    "phone number": "phone",
    // Name
    "fname": "first_name",
    "first name": "first_name",
    "given-name": "first_name",
    "lname": "last_name",
    "last name": "last_name",
    "family-name": "last_name",
    "name": "full_name",
    "full name": "full_name",
    // Address
    "address": "address_line1",
    "address-line1": "address_line1",
    "address1": "address_line1",
    "street address": "address_line1",
    "address-line2": "address_line2",
    "address2": "address_line2",
    "city": "city",
    "locality": "city",
    "state": "state",
    "region": "state",
    "province": "state",
    "zip": "postal_code",
    "postal-code": "postal_code",
    "zip code": "postal_code",
    "zipcode": "postal_code",
    "country": "country",
    // Financial
    "cc-number": "credit_card",
    "card number": "credit_card",
    "card": "credit_card",
    // Exclude
    "password": "password", // Will be excluded by cache
    "new-password": "password",
    "current-password": "password",
    "one-time-code": "otp",
    "otp": "otp"
};
/**
 * Returns a semantic key (e.g. "email", "first_name") or null if it cannot
 * be robustly classified.
 */
export function classifyField(context) {
    // 1. Check strict autocomplete hint first
    if (context.autocomplete) {
        const tokens = context.autocomplete.toLowerCase().split(/\s+/);
        for (const token of tokens) {
            if (NORMALIZE_MAP[token]) {
                return NORMALIZE_MAP[token];
            }
        }
    }
    // 2. Check input type
    if (context.type) {
        const t = context.type.toLowerCase();
        if (t === "email")
            return "email";
        if (t === "tel")
            return "phone";
        if (t === "password")
            return "password";
    }
    // 3. Fallback to heuristics on name, id, label
    const signals = [
        context.name?.toLowerCase(),
        context.id?.toLowerCase(),
        context.label?.toLowerCase()
    ].filter(Boolean);
    for (const signal of signals) {
        // Exact match in map
        if (NORMALIZE_MAP[signal])
            return NORMALIZE_MAP[signal];
        // Substring match heuristics
        if (signal.includes("email"))
            return "email";
        if (signal.includes("password"))
            return "password";
        if (signal.includes("first") && signal.includes("name"))
            return "first_name";
        if (signal.includes("last") && signal.includes("name"))
            return "last_name";
        if (signal.includes("phone") || signal.includes("mobile"))
            return "phone";
        if (signal.includes("address") && (signal.includes("1") || signal.includes("line1")))
            return "address_line1";
        if (signal.includes("address") && (signal.includes("2") || signal.includes("line2")))
            return "address_line2";
        if (signal.includes("zip") || signal.includes("postal"))
            return "postal_code";
        if (signal.includes("city"))
            return "city";
        if (signal.includes("state") || signal.includes("province"))
            return "state";
        if (signal.includes("country"))
            return "country";
        if (signal.includes("card") && signal.includes("number"))
            return "credit_card";
        if (signal.includes("otp") || signal.includes("one-time"))
            return "otp";
    }
    // 4. Use existing PII classification as a last resort
    if (context.piiType) {
        const pii = context.piiType.toUpperCase();
        switch (pii) {
            case "EMAIL": return "email";
            case "PHONE": return "phone";
            case "CREDIT_CARD": return "credit_card";
            case "PASSWORD": return "password";
            case "OTP": return "otp";
            case "PERSON": return "full_name";
            case "ADDRESS": return "address_line1";
        }
    }
    return null;
}
