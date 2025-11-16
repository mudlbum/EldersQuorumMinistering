/**
 * pdfParser.js - FIXED FOR COLUMN-BASED TABLE FORMAT
 *
 * This file contains all logic related to parsing the PDF file.
 * FIXED: Properly handles multi-column table format where people are in columns
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
 * FIXED: Groups items by column (X-coordinate) to prevent mixing data between people
 */
export async function parsePdfMembers(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    console.log(`PDF has ${pdf.numPages} pages.`);
    
    let allMembers = [];
    const PAGES_PER_BATCH = 5;
    
    for (let batchStart = 1; batchStart <= pdf.numPages; batchStart += PAGES_PER_BATCH) {
        const batchEnd = Math.min(batchStart + PAGES_PER_BATCH - 1, pdf.numPages);
        console.log(`Processing pages ${batchStart}-${batchEnd}...`);
        
        if (window.localParserProgress) {
            const percent = Math.floor((batchStart / pdf.numPages) * 100);
            window.localParserProgress(batchStart, pdf.numPages, allMembers.length, percent);
        }
        
        // Extract all text items with positions
        let allItems = [];
        
        for (let i = batchStart; i <= batchEnd; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            
            for (const item of textContent.items) {
                if (item.str.trim().length > 0) {
                    allItems.push({
                        text: item.str.trim(),
                        x: Math.round(item.transform[4]),
                        y: Math.round(item.transform[5])
                    });
                }
            }
        }
        
        const batchMembers = parseItemsWithColumnDetection(allItems);
        console.log(`Batch ${batchStart}-${batchEnd} yielded ${batchMembers.length} members`);
        allMembers = allMembers.concat(batchMembers);
    }
    
    console.log(`Local parser extracted ${allMembers.length} total members`);
    
    const households = groupMembersIntoHouseholds(allMembers);
    console.log(`Grouped into ${households.length} households`);
    
    return { households, rawMembers: allMembers };
}

/**
 * NEW: Parse items with column detection to prevent mixing data
 */
function parseItemsWithColumnDetection(items) {
    const members = [];
    
    const namePattern = /^[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?,\s+[A-Z][a-zA-Z\s]+/;
    const footerKeywords = [
        'Member List', 'For Church Use Only', 'Name Gender Age', 
        'Richmond Hill Ward', 'Toronto Ontario Stake', 'Individuals',
        'by Intellectual Reserve', 'All rights reserved', 'Birth Date',
        'Phone Number', 'E-mail', 'Address'
    ];
    
    // Step 1: Find all names and their X positions
    const namePositions = [];
    for (const item of items) {
        if (namePattern.test(item.text) && !footerKeywords.some(kw => item.text.includes(kw))) {
            namePositions.push({
                name: item.text,
                x: item.x,
                y: item.y
            });
        }
    }
    
    if (namePositions.length === 0) {
        console.log("No names found in items");
        return [];
    }
    
    console.log(`Found ${namePositions.length} names`);
    
    // Step 2: Determine column boundaries
    // Group names by similar X positions (within 50 pixels)
    const columns = [];
    const COLUMN_THRESHOLD = 50;
    
    for (const namePos of namePositions) {
        let foundColumn = false;
        for (const col of columns) {
            if (Math.abs(col.x - namePos.x) < COLUMN_THRESHOLD) {
                col.names.push(namePos);
                foundColumn = true;
                break;
            }
        }
        if (!foundColumn) {
            columns.push({
                x: namePos.x,
                names: [namePos]
            });
        }
    }
    
    // Sort columns left to right
    columns.sort((a, b) => a.x - b.x);
    console.log(`Detected ${columns.length} column(s)`);
    
    // Step 3: For each name, collect only items in its column
    for (const namePos of namePositions) {
        const member = parseMemberInColumn(namePos, items, columns);
        if (member) {
            members.push(member);
        }
    }
    
    console.log(`Extracted ${members.length} members`);
    return members;
}

/**
 * Parse a single member by collecting only items in their column
 */
function parseMemberInColumn(namePos, allItems, columns) {
    // Find which column this name belongs to
    let columnX = namePos.x;
    let columnWidth = 200; // Default column width
    
    // If multiple columns, calculate width
    if (columns.length > 1) {
        const colIndex = columns.findIndex(col => 
            col.names.some(n => n.x === namePos.x && n.y === namePos.y)
        );
        
        if (colIndex !== -1) {
            columnX = columns[colIndex].x;
            // Width extends halfway to next column
            if (colIndex < columns.length - 1) {
                columnWidth = (columns[colIndex + 1].x - columnX) * 0.8;
            } else {
                columnWidth = 300; // Last column
            }
        }
    }
    
    const leftBound = columnX - 20;
    const rightBound = columnX + columnWidth;
    
    // Collect items in this column that come after this name
    const memberItems = allItems.filter(item => {
        const inColumn = item.x >= leftBound && item.x <= rightBound;
        const afterName = item.y <= namePos.y; // Y decreases going down in PDF
        return inColumn && afterName;
    });
    
    // Sort by Y position (top to bottom)
    memberItems.sort((a, b) => b.y - a.y);
    
    // Find where this member's data ends (next name in same column or big Y gap)
    let endIndex = memberItems.length;
    for (let i = 1; i < memberItems.length; i++) {
        const item = memberItems[i];
        const prevItem = memberItems[i - 1];
        
        // Stop at next name
        if (/^[A-Z][a-z]+,\s+[A-Z]/.test(item.text) && item.text !== namePos.name) {
            endIndex = i;
            break;
        }
        
        // Stop at large Y gap (more than 50 pixels)
        if (Math.abs(prevItem.y - item.y) > 50) {
            endIndex = i;
            break;
        }
    }
    
    const thisMememberItems = memberItems.slice(0, endIndex);
    
    return extractMemberFromItems(namePos.name, thisMememberItems);
}

/**
 * Extract member data from their items
 */
function extractMemberFromItems(name, items) {
    const member = {
        id: crypto.randomUUID(),
        name: name,
        gender: '',
        age: '',
        addressLines: [],
        phone: '',
        email: '',
        note: ''
    };
    
    const genderPattern = /^[MF]$/;
    const agePattern = /^\d{1,3}$/;
    const dateComponents = /^(\d{1,2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})$/i;
    const phoneRegex = /^[\+\d][\d\s\(\)\-\.]+\d$/;
    const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const postalCodePattern = /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i;
    
    for (const item of items) {
        const text = item.text;
        
        // Skip name itself
        if (text === name) continue;
        
        // Gender
        if (genderPattern.test(text) && !member.gender) {
            member.gender = text;
            continue;
        }
        
        // Age (must be reasonable)
        if (agePattern.test(text) && !member.age) {
            const age = parseInt(text);
            if (age >= 1 && age <= 120) {
                member.age = text;
                continue;
            }
        }
        
        // Skip birth date components
        if (dateComponents.test(text)) {
            continue;
        }
        
        // Phone
        if (phoneRegex.test(text) && text.length >= 10 && !member.phone) {
            member.phone = text;
            continue;
        }
        
        // Email
        if (emailRegex.test(text) && !member.email) {
            member.email = text;
            continue;
        }
        
        // Address (anything else substantial)
        if (text.length > 1 && !text.match(/^[\d\s\-]+$/)) {
            member.addressLines.push(text);
            
            // Stop collecting if we hit postal code
            if (postalCodePattern.test(text)) {
                break;
            }
        }
    }
    
    // Finalize address
    member.address = member.addressLines
        .join(', ')
        .replace(/\s+/g, ' ')
        .replace(/,+/g, ',')
        .replace(/^,|,$/g, '')
        .trim();

    if (!member.address || member.address.length < 5) {
        member.address = "No Address in PDF";
    }

    member.note = `Gender: ${member.gender || '?'}, Age: ${member.age || '?'}`;
    
    console.log(`Parsed: ${member.name}, Gender: ${member.gender}, Age: ${member.age}, Address: ${member.address}`);
    
    return member;
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
    
    const estimatedTokens = pdfText.length / 4;
    const MAX_TOKENS = 80000;
    
    console.log(`PDF text length: ${pdfText.length} chars, estimated ${estimatedTokens.toFixed(0)} tokens`);
    
    let allMembers = [];
    
    if (estimatedTokens > MAX_TOKENS) {
        console.log(`Large PDF detected. Using chunked parsing...`);
        allMembers = await parsePdfWithGeminiChunked(pdfText, geminiApiKey);
    } else {
        console.log("PDF is small enough for single request");
        allMembers = await parsePdfWithGeminiSingle(pdfText, geminiApiKey);
    }
    
    allMembers.forEach(m => {
        if (!m.id) m.id = crypto.randomUUID();
        m.note = `Gender: ${m.gender || '?'}, Age: ${m.age || '?'}`;
        if (!m.address || !m.address.trim()) {
            m.address = "No Address in PDF";
        }
    });
    
    const households = groupMembersIntoHouseholds(allMembers);
    return { households, rawMembers: allMembers };
}

async function parsePdfWithGeminiSingle(pdfText, geminiApiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`;
    
    const systemPrompt = `You are an expert data extraction tool. Parse this PDF member directory text into a JSON array.

CRITICAL RULES:
1. Parse EVERY member - do not skip any
2. Each person is ONE entry with their own complete information
3. Names are in "Last, First" format
4. Combine multi-line addresses into ONE string per person
5. Extract gender (M/F) and age
6. Extract first phone and email found for each person
7. If missing, use empty string ""

Example:
"Abbasi, Zohreh F 32 ... 58 Morgan Ave THORNHILL ON L3T 1R2 416-529-7579"
becomes:
{"name": "Abbasi, Zohreh", "gender": "F", "age": "32", "address": "58 Morgan Ave, THORNHILL ON L3T 1R2", "phone": "416-529-7579", "email": ""}`;

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
            },
            temperature: 0.0,
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
    console.log("Starting chunked PDF parsing...");
    
    const lines = pdfText.split('\n');
    const namePattern = /^[A-Z][a-z]+(?:-[A-Z][a-z]+)*,\s+[A-Za-z\s]+/;
    
    let chunks = [];
    let currentChunk = [];
    let memberCount = 0;
    const MEMBERS_PER_CHUNK = 25;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (namePattern.test(line)) {
            if (memberCount >= MEMBERS_PER_CHUNK && currentChunk.length > 0) {
                chunks.push(currentChunk.join('\n'));
                currentChunk = [];
                memberCount = 0;
            }
            memberCount++;
        }
        
        currentChunk.push(lines[i]);
    }
    
    if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
    }
    
    console.log(`Split PDF into ${chunks.length} chunks`);
    
    let allMembers = [];
    let failedChunks = 0;
    
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing chunk ${i + 1}/${chunks.length}...`);
        
        if (window.geminiChunkProgress) {
            window.geminiChunkProgress(i + 1, chunks.length, allMembers.length);
        }
        
        try {
            const chunkMembers = await processGeminiChunk(chunks[i], geminiApiKey, i + 1, chunks.length);
            
            if (chunkMembers && chunkMembers.length > 0) {
                allMembers = allMembers.concat(chunkMembers);
                console.log(`✓ Chunk ${i + 1} yielded ${chunkMembers.length} members. Total: ${allMembers.length}`);
            } else {
                failedChunks++;
            }
            
            if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            
        } catch (chunkError) {
            console.error(`✗ Error processing chunk ${i + 1}:`, chunkError.message);
            failedChunks++;
            
            if (failedChunks > chunks.length * 0.3) {
                throw new Error(`Too many chunks failed (${failedChunks}/${i + 1})`);
            }
        }
    }
    
    console.log(`Chunked parsing complete. Total members: ${allMembers.length}`);
    
    if (allMembers.length === 0) {
        throw new Error("No members extracted from any chunks");
    }
    
    return allMembers;
}

async function processGeminiChunk(chunkText, geminiApiKey, chunkNum, totalChunks) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`;
    
    const systemPrompt = `Parse this PDF text into a JSON array of members. Each person gets ONE entry with their complete info. Combine multi-line addresses. Format: {"name": "Last, First", "gender": "M/F", "age": "number", "address": "full address", "phone": "number", "email": "address"}`;
    
    const payload = {
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${chunkText}` }] }],
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
            },
            temperature: 0.0,
        }
    };
    
    const data = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return [];
    
    return extractMembersFromJSON(text);
}

function extractMembersFromJSON(text) {
    let cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const arrayStart = cleanText.indexOf('[');
    const arrayEnd = cleanText.lastIndexOf(']');
    
    if (arrayStart === -1 || arrayEnd === -1) {
        try {
            const members = JSON.parse(cleanText);
            return Array.isArray(members) ? members : [members];
        } catch (e) {
            console.error("No valid JSON found");
            return [];
        }
    }
    
    cleanText = cleanText.substring(arrayStart, arrayEnd + 1);
    
    try {
        const members = JSON.parse(cleanText);
        return Array.isArray(members) ? members : [];
    } catch (parseError) {
        console.error("JSON parse error:", parseError.message);
        return [];
    }
}

export function deduplicateMembers(localMembers, geminiMembers) {
    console.log(`Deduplicating: ${localMembers.length} local + ${geminiMembers.length} Gemini`);
    
    const seen = new Set();
    const deduplicated = [];
    
    const getMemberKey = (member) => {
        const name = (member.name || '').trim().toLowerCase();
        const addressPart = (member.address || '').split(',')[0].trim().toLowerCase();
        return `${name}|${addressPart}`;
    };
    
    for (const member of localMembers) {
        const key = getMemberKey(member);
        if (!seen.has(key)) {
            seen.add(key);
            deduplicated.push(member);
        }
    }
    
    const localCount = deduplicated.length;
    
    for (const member of geminiMembers) {
        const key = getMemberKey(member);
        if (!seen.has(key)) {
            seen.add(key);
            deduplicated.push(member);
        }
    }
    
    console.log(`Deduplication complete: ${deduplicated.length} unique members`);
    console.log(`  - From local parser: ${localCount}`);
    console.log(`  - Added from Gemini: ${deduplicated.length - localCount}`);
    console.log(`  - Duplicates skipped: ${(localMembers.length + geminiMembers.length) - deduplicated.length}`);
    
    return deduplicated;
}

function groupMembersIntoHouseholds(members) {
    const households = {};
    const unassignedHouseholds = [];

    for (const member of members) {
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
                    address: member.address,
                    coords: null,
                    isCaregiverEligible: true,
                    note: '',
                };
            }
            households[addressKey].members.push(member);
        } else {
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
    
    Object.values(households).forEach(h => {
        h.note = h.members.map(m => `${m.name} (G: ${m.gender || '?'}, A: ${m.age || '?'})`).join(' | ');
    });

    const finalHouseholdList = Object.values(households).concat(unassignedHouseholds);
    console.log(`Grouped into ${finalHouseholdList.length} households.`);
    
    return finalHouseholdList;
}