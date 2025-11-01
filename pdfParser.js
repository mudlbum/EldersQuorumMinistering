/**
 * pdfParser.js - FIXED VERSION
 *
 * This file contains all logic related to parsing the PDF file.
 * It reconstructs lines and groups members into households.
 */
import { fetchWithRetry } from './services.js';

/**
 * Extracts raw text content from all pages of a PDF.
 */
async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += pageText + '\n\n';
    }
    return fullText;
}

/**
 * Main PDF parsing function (LOCAL PARSER).
 * Extracts text content from all pages into clean lines.
 */
export async function parsePdfMembers(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    console.log(`PDF has ${pdf.numPages} pages.`);
    
    let allLines = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        // Group items by their Y-coordinate (transform[5])
        const lineMap = new Map();
        for (const item of textContent.items) {
            const y = Math.round(item.transform[5] * 10) / 10; 
            if (!lineMap.has(y)) {
                lineMap.set(y, []);
            }
            lineMap.get(y).push(item);
        }

        // Sort lines by Y-coordinate (top to bottom)
        const sortedLines = [...lineMap.entries()].sort((a, b) => b[0] - a[0]);

        // For each line, sort items by X-coordinate (left to right) and join
        for (const [, items] of sortedLines) {
            const line = items
                .sort((a, b) => a.transform[4] - b.transform[4])
                .map(item => item.str)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            
            if (line.length > 2) {
                allLines.push(line);
            }
        }
    }
    
    return parseMemberLines(allLines);
}

/**
 * Parses the reconstructed lines into member objects.
 * FIXED: This version uses block-based parsing to correctly group multi-line addresses.
 */
function parseMemberLines(lines) {
    const members = [];
    let currentBlock = []; // Stores lines for a single member

    // Pattern to detect a NEW member line (Name, Gender, Age, Birth Date)
    // This pattern looks for the *end* of the line (vitals)
    const namePattern = /([MF])\s+(\d{1,3})\s+(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i;
    
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
    const footerPatterns = [
        /Member List/i,
        /For Church Use Only/i,
        /Name Gender Age/i,
        /Richmond Hill Ward/i,
        /Toronto Ontario Stake/i,
        /Page \d+ of \d+/i
    ];

    const processBlock = () => {
        if (currentBlock.length === 0) return;

        let member = {
            id: crypto.randomUUID(),
            name: '',
            gender: '',
            age: '',
            addressLines: [],
            phone: '',
            email: '',
            note: ''
        };

        // First line *should* contain the name and vitals
        const firstLine = currentBlock[0];
        const match = firstLine.match(namePattern);
        
        if (match) {
            // Name is everything before the match
            member.name = firstLine.substring(0, match.index).trim();
            member.gender = match[1];
            member.age = match[2];
            
            // Check for phone/email/address on the *first line* after vitals
            let remainingFirstLine = firstLine.substring(match.index + match[0].length).trim();
            if (remainingFirstLine.length > 3) {
                // Re-insert it as a new line to be processed
                currentBlock.splice(1, 0, remainingFirstLine); 
            }
        } else {
            // Could not parse this block, discard
            console.warn("Skipping unparsable block:", currentBlock);
            currentBlock = [];
            return;
        }

        // Process all other lines (and the remainder of the first line, if any)
        for (let i = 1; i < currentBlock.length; i++) {
            const line = currentBlock[i].trim();
            const phoneMatch = line.match(phoneRegex);
            const emailMatch = line.match(emailRegex);

            // Check if line is *mostly* just a phone number
            if (phoneMatch && phoneMatch[0].length >= line.length - 5 && !member.phone) {
                member.phone = phoneMatch[0];
            } 
            // Check if line is *mostly* just an email
            else if (emailMatch && emailMatch[0].length >= line.length - 5 && !member.email) {
                member.email = emailMatch[0];
            } 
            // Otherwise, assume it's an address line
            else if (line.length > 3) { 
                member.addressLines.push(line);
            }
        }

        // Finalize member object
        // Join address lines with a comma and space
        member.address = member.addressLines.join(', ')
            .replace(/"/g, '') // Remove quotes
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();
            
        if (!member.address) {
            member.address = "No Address in PDF";
        }
        member.note = `Gender: ${member.gender || '?'}, Age: ${member.age || '?'}`;
        
        // Don't add members with no name
        if (member.name) {
            members.push(member);
        }
        
        currentBlock = []; // Reset for next member
    };

    // --- Main Loop ---
    for (const line of lines) {
        // Check for footers
        if (footerPatterns.some(pattern => pattern.test(line))) {
            continue;
        }

        // Check if this line is the start of a new member
        const match = line.match(namePattern);

        if (match) {
            // It's a new member. Process the *previous* block.
            processBlock();
            // Start the new block
            currentBlock.push(line);
        } else if (currentBlock.length > 0) {
            // It's a continuation line. Add to the current block.
            currentBlock.push(line);
        }
        // If currentBlock.length is 0 and it's not a new member line, we ignore it (it's junk)
    }
    
    // Process the very last block
    processBlock();
    
    console.log(`Parsed ${members.length} members from PDF`);
    return groupMembersIntoHouseholds(members);
}


/**
 * Fallback PDF parsing function using Gemini API.
 */
export async function parsePdfWithGemini(file, geminiApiKey) {
    if (!geminiApiKey) {
        throw new Error("Advanced parsing requires a Gemini API key. Please add one in the sidebar.");
    }

    console.log("Extracting text for Gemini...");
    const pdfText = await extractPdfText(file);

    // --- FIX: Use production-ready model ---
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;
    
    const systemPrompt = `You are an expert data extraction tool. Parse the provided text from a PDF member directory and convert it into a valid JSON array. Each object in the array should represent one person.

IMPORTANT INSTRUCTIONS:
- Extract COMPLETE addresses by combining multi-line address information
- Addresses typically span 2-4 lines (street, city/province, postal code)
- Name format: "Last, First" or "Last, First Middle"
- Gender is typically M or F
- Age is typically a 1-3 digit number
- If a value is missing, use an empty string ""

Example format in PDF:
Name: "Abbasi, Zohreh"
Gender/Age: F 32
Birth Date: 18 Jul 1993
Address Line 1: 58 Morgan Ave
Address Line 2: THORNHILL ON L3T
Address Line 3: 1R2
Phone: 416-529-7579

Should become:
{
  "name": "Abbasi, Zohreh",
  "gender": "F",
  "age": "32",
  "address": "58 Morgan Ave, THORNHILL ON L3T 1R2",
  "phone": "416-529-7579",
  "email": ""
}`;
    
    const userQuery = `Extract all members from the following text into a JSON array. Pay special attention to combining multi-line addresses into complete, full addresses.

${pdfText}`;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
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
                    },
                    required: ["name", "address"]
                }
            }
        }
    };

    console.log("Calling Gemini API for advanced parsing...");
    const data = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;

    if (!text) {
        console.error("Gemini parsing returned no data.", data);
        return [];
    }

    const members = JSON.parse(text);
    console.log(`Gemini parsed ${members.length} members.`);

    // Add required fields for grouping
    members.forEach(m => {
        m.id = crypto.randomUUID();
        m.note = `Gender: ${m.gender || '?'}, Age: ${m.age || '?'}`;
        if (!m.address || !m.address.trim()) {
            m.address = "No Address in PDF";
        }
    });

    return groupMembersIntoHouseholds(members);
}

/**
 * Groups individual members into household objects based on address.
 */
function groupMembersIntoHouseholds(members) {
    const households = {};
    const unassignedHouseholds = [];

    for (const member of members) {
        // Normalize address for grouping (remove apartment numbers, etc.)
        const addressKey = member.address
            .replace(/\bApt\s*\.?\s*\d+/gi, '')
            .replace(/\bSuite\s*\.?\s*\d+/gi, '')
            .replace(/\bUnit\s*\.?\s*\d+/gi, '')
            .replace(/#\d+/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        if (addressKey && addressKey !== "no address in pdf" && addressKey.length > 10) {
            if (!households[addressKey]) {
                households[addressKey] = {
                    id: crypto.randomUUID(),
                    members: [],
                    address: member.address, // Keep original full address
                    coords: null,
                    isCaregiverEligible: true,
                    note: '',
                };
            }
            households[addressKey].members.push(member);
        } else {
            // No valid address, create a "household" of one
            unassignedHouseholds.push({
                id: member.id,
                members: [member],
                address: "No Address in PDF",
                coords: null,
                isCaregiverEligible: true,
                note: member.note
            });
        }
    }
    
    // Create household note from all members
    Object.values(households).forEach(h => {
        h.note = h.members.map(m => `${m.name} (G: ${m.gender || '?'}, A: ${m.age || '?'})`).join(' | ');
    });

    const finalHouseholdList = Object.values(households).concat(unassignedHouseholds);
    console.log(`Grouped into ${finalHouseholdList.length} households.`);
    
    return finalHouseholdList;
}
