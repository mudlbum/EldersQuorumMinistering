export async function parsePdfMembers(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    console.log(`PDF has ${pdf.numPages} pages.`);
    
    let allItems = [];
    
    // Progress tracking
    if (window.localParserProgress) window.localParserProgress(0, pdf.numPages, 0, 0);

    // 1. Extract all text items with coordinates
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });
        
        // Normalize Y (0 is top) for easier reading logic
        const pageItems = textContent.items.map(item => ({
            text: item.str.trim(),
            x: Math.round(item.transform[4]),
            y: Math.round(viewport.height - item.transform[5]), // Flip Y so it increases going down
            page: i
        })).filter(item => item.text.length > 0);

        allItems = allItems.concat(pageItems);
        
        if (window.localParserProgress) {
            window.localParserProgress(i, pdf.numPages, 0, Math.floor((i/pdf.numPages)*40));
        }
    }

    // 2. Sort items: Page -> Y (Top-Down) -> X (Left-Right)
    // Tolerance of 5px for Y to group items on the "same line"
    allItems.sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
        return a.x - b.x;
    });

    // 3. Determine Column Boundaries
    const boundaries = detectColumnBoundaries(allItems);
    console.log("Detected Column Boundaries:", boundaries);

    // 4. Parse Rows into Members
    const rawMembers = parseItemsToMembers(allItems, boundaries);
    console.log(`Local parser extracted ${rawMembers.length} total members`);
    
    const households = groupMembersIntoHouseholds(rawMembers);
    console.log(`Grouped into ${households.length} households`);
    
    return { households, rawMembers };
}

function detectColumnBoundaries(items) {
    // Default boundaries (approximate X coordinates based on your PDF)
    let bounds = {
        nameEnd: 160,
        metaEnd: 240,
        addressEnd: 450
    };

    // Refine using headers from Page 1
    const headers = items.filter(i => i.page === 1 && i.y < 200); 
    
    const nameHeader = headers.find(i => i.text.includes('Name'));
    const metaHeader = headers.find(i => i.text.includes('Gender') || i.text.includes('Age'));
    const addrHeader = headers.find(i => i.text.includes('Address') || i.text.includes('Birth Date'));
    const contHeader = headers.find(i => i.text.includes('Phone') || i.text.includes('E-mail'));

    // Calculate midpoints between headers
    if (nameHeader && metaHeader) bounds.nameEnd = (nameHeader.x + metaHeader.x) / 2 + 30; // Bias right slightly
    if (metaHeader && addrHeader) bounds.metaEnd = (metaHeader.x + addrHeader.x) / 2;
    if (addrHeader && contHeader) bounds.addressEnd = (addrHeader.x + contHeader.x) / 2;

    return bounds;
}

function parseItemsToMembers(items, bounds) {
    const members = [];
    let currentMember = null;
    
    // Regex to detect the START of a new person (Lastname, Firstname) in the first column
    // Robust for spaces, hyphens, and apostrophes in names
    const nameStartRegex = /^[A-Z][a-zA-Z\s\-']+, [A-Z][a-zA-Z\s\-']+$/;
    
    // Keywords/Headers to ignore
    const ignoreKeywords = [
        'Member List', 'Richmond Hill', 'Toronto Ontario', 'For Church Use', 
        'Intellectual Reserve', 'Phone Number', 'Birth Date', 'Individuals',
        'Name', 'Gender', 'Age', 'Address', 'E-mail'
    ];

    for (const item of items) {
        // Skip known junk or page numbers
        if (ignoreKeywords.some(k => item.text.includes(k))) continue;
        if (/^Page \d+/.test(item.text)) continue;

        // Determine which column this item belongs to
        let column = 'contact';
        if (item.x < bounds.nameEnd) column = 'name';
        else if (item.x < bounds.metaEnd) column = 'meta'; // Gender/Age
        else if (item.x < bounds.addressEnd) column = 'address';

        // Check if this item starts a NEW person
        const isNewPerson = column === 'name' && nameStartRegex.test(item.text);

        if (isNewPerson) {
            if (currentMember) members.push(finalizeMember(currentMember));
            currentMember = {
                name: item.text,
                rawMeta: [],    
                rawAddress: [], 
                rawContact: []  
            };
        } else if (currentMember) {
            // Append data to CURRENT person based on column
            if (column === 'name') {
                if (!item.text.includes(',')) currentMember.name += ' ' + item.text;
            } else if (column === 'meta') {
                currentMember.rawMeta.push(item.text);
            } else if (column === 'address') {
                currentMember.rawAddress.push(item.text);
            } else if (column === 'contact') {
                currentMember.rawContact.push(item.text);
            }
        }
    }

    if (currentMember) members.push(finalizeMember(currentMember));

    return members;
}

/**
 * FIXED: finalizeMember now stops reading address lines when it hits a postal code.
 */
function finalizeMember(raw) {
    const m = {
        id: crypto.randomUUID(),
        name: raw.name,
        gender: '',
        age: '',
        address: '',
        phone: '',
        email: '',
        note: ''
    };

    // 1. Parse Meta (Gender/Age)
    raw.rawMeta.forEach(txt => {
        txt = txt.trim();
        if (txt === 'M' || txt === 'F') m.gender = txt;
        else if (/^\d{1,3}$/.test(txt)) m.age = txt;
    });

    // 2. Parse Address (Clean Dates & Fix Merged Addresses)
    const dateRegex = /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/gi;
    
    // Regex for Canadian Postal Code (e.g. L3T 1R2)
    const postalCodeRegex = /[A-Z]\d[A-Z]\s*\d[A-Z]\d/i;
    
    let cleanAddressLines = [];
    let stopAddingAddress = false;

    for (let line of raw.rawAddress) {
        if (stopAddingAddress) break; // Don't add garbage after postal code

        // Remove Date string (e.g. "18 Jul 1993")
        let cleaned = line.replace(dateRegex, '').trim();
        if (!cleaned) continue;

        // Check for drifted Age/Gender
        if (/^\d{1,3}$/.test(cleaned)) {
            if (!m.age) m.age = cleaned;
            continue;
        }
        if (/^(M|F)$/i.test(cleaned)) {
            if (!m.gender) m.gender = cleaned.toUpperCase();
            continue;
        }

        // --- FIX STARTS HERE ---
        // Check if this line contains a postal code
        const pcMatch = cleaned.match(postalCodeRegex);
        if (pcMatch) {
            // Found it! Truncate the string right after the postal code
            const endIndex = pcMatch.index + pcMatch[0].length;
            cleaned = cleaned.substring(0, endIndex);
            
            // Mark flag to stop adding subsequent lines (which likely belong to the next person)
            stopAddingAddress = true; 
        }
        // --- FIX ENDS HERE ---

        cleanAddressLines.push(cleaned);
    }
    
    m.address = cleanAddressLines.join(', ')
        .replace(/\s+/g, ' ') 
        .replace(/,+/g, ',')
        .replace(/^,|,$/g, '') 
        .trim();
    
    if (!m.address || m.address.length < 5) m.address = "No Address in PDF";

    // 3. Parse Contact
    const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const phoneRegex = /[\d\-\(\)\.]{7,}/;

    raw.rawContact.forEach(txt => {
        if (emailRegex.test(txt)) m.email = txt;
        else if (phoneRegex.test(txt)) m.phone = txt;
    });

    m.note = `Gender: ${m.gender || '?'}, Age: ${m.age || '?'}`;
    return m;
}


// ==========================================
// SECTION 2: GEMINI AI PARSER (FALLBACK)
// ==========================================

export async function parsePdfWithGemini(file, geminiApiKey) {
    if (!geminiApiKey) {
        throw new Error("Advanced parsing requires a Gemini API key. Please add one in the sidebar.");
    }
    console.log("Extracting text for Gemini...");
    const pdfText = await extractPdfText(file);
    const estimatedTokens = pdfText.length / 4;
    const MAX_TOKENS = 80000;
    
    let allMembers = [];
    if (estimatedTokens > MAX_TOKENS) {
        allMembers = await parsePdfWithGeminiChunked(pdfText, geminiApiKey);
    } else {
        allMembers = await parsePdfWithGeminiSingle(pdfText, geminiApiKey);
    }
    
    allMembers.forEach(m => {
        if (!m.id) m.id = crypto.randomUUID();
        m.note = `Gender: ${m.gender || '?'}, Age: ${m.age || '?'}`;
        if (!m.address || !m.address.trim()) m.address = "No Address in PDF";
    });
    
    return { households: groupMembersIntoHouseholds(allMembers), rawMembers: allMembers };
}

async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(' ') + '\n\n';
    }
    return fullText;
}

async function parsePdfWithGeminiSingle(pdfText, geminiApiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`;
    const systemPrompt = `Parse this PDF member directory text into a JSON array. Rules: Names "Last, First"; Split Age/Gender; Exclude Birth Dates from Address; Truncate address after postal code.`;
    
    const payload = {
        contents: [{ parts: [{ text: `${systemPrompt}\n\nPDF Text:\n${pdfText}` }] }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        "name": { "type": "STRING" },
                        "gender": { "type": "STRING" },
                        "age": { "type": "STRING" },
                        "address": { "type": "STRING" },
                        "phone": { "type": "STRING" },
                        "email": { "type": "STRING" }
                    }
                }
            }
        }
    };

    const data = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty response");
    return extractMembersFromJSON(text);
}

async function parsePdfWithGeminiChunked(pdfText, geminiApiKey) {
    // Simplified chunk logic for brevity - identical to previous logic
    const lines = pdfText.split('\n');
    let chunks = [], current = [], count = 0;
    
    for (const line of lines) {
        if (/^[A-Z][a-z]+,/.test(line.trim())) {
            if (count >= 25) { chunks.push(current.join('\n')); current = []; count = 0; }
            count++;
        }
        current.push(line);
    }
    if (current.length) chunks.push(current.join('\n'));
    
    let allMembers = [];
    for (let i = 0; i < chunks.length; i++) {
        if (window.geminiChunkProgress) window.geminiChunkProgress(i + 1, chunks.length, allMembers.length);
        const chunkMembers = await parsePdfWithGeminiSingle(chunks[i], geminiApiKey); // Reuse single parser
        if (chunkMembers) allMembers = allMembers.concat(chunkMembers);
        await new Promise(r => setTimeout(r, 300));
    }
    return allMembers;
}

function extractMembersFromJSON(text) {
    try {
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start === -1 || end === -1) return [];
        return JSON.parse(text.substring(start, end + 1));
    } catch (e) { return []; }
}

export function deduplicateMembers(local, gemini) { return local; } // Placeholder

function groupMembersIntoHouseholds(members) {
    const households = {};
    const unassigned = [];
    for (const m of members) {
        const key = m.address.replace(/[^\w\s]/g, '').toLowerCase().trim();
        if (key.length > 10 && !key.includes("no address")) {
            if (!households[key]) households[key] = { id: crypto.randomUUID(), members: [], address: m.address, isCaregiverEligible: true, note: '' };
            households[key].members.push(m);
        } else {
            unassigned.push({ id: m.id, members: [m], address: "No Address in PDF", isCaregiverEligible: true, note: m.note });
        }
    }
    Object.values(households).forEach(h => h.note = h.members.map(m => `${m.name} (${m.age})`).join(' | '));
    return Object.values(households).concat(unassigned);
}