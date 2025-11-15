/**
 * pdfParser.js - IMPROVED VERSION
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
 * NOW: Processes in pages or chunks to handle large files better.
 * Returns both households and raw members for deduplication.
 */
export async function parsePdfMembers(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    console.log(`PDF has ${pdf.numPages} pages.`);
    
    let allMembers = []; // Track individual members for deduplication
    const PAGES_PER_BATCH = 5; // Process 5 pages at a time
    
    for (let batchStart = 1; batchStart <= pdf.numPages; batchStart += PAGES_PER_BATCH) {
        const batchEnd = Math.min(batchStart + PAGES_PER_BATCH - 1, pdf.numPages);
        console.log(`Processing pages ${batchStart}-${batchEnd}...`);
        
        // Report progress to UI if callback exists
        if (window.localParserProgress) {
            const percent = Math.floor((batchStart / pdf.numPages) * 100);
            window.localParserProgress(batchStart, pdf.numPages, allMembers.length, percent);
        }
        
        let batchLines = [];
        
        for (let i = batchStart; i <= batchEnd; i++) {
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
                    batchLines.push(line);
                }
            }
        }
        
        // Parse this batch of lines - get raw members
        const batchMembers = parseMemberLinesRaw(batchLines);
        console.log(`Batch ${batchStart}-${batchEnd} yielded ${batchMembers.length} members`);
        allMembers = allMembers.concat(batchMembers);
    }
    
    console.log(`Local parser extracted ${allMembers.length} total members`);
    
    // Now group into households
    const households = groupMembersIntoHouseholds(allMembers);
    console.log(`Grouped into ${households.length} households`);
    
    // Return both for deduplication later
    return { households, rawMembers: allMembers };
}

/**
 * IMPROVED: Parses the reconstructed lines into member objects.
 * NOW: Returns raw member array instead of households for better deduplication
 */
function parseMemberLinesRaw(lines) {
    const members = [];
    
    // Patterns
    const namePattern = /^([A-Z][a-z]+(?:-[A-Z][a-z]+)*,\s+[A-Za-z\s]+?)(?:\s+[MF]\s+\d{1,3}|\s*$)/;
    const genderAgePattern = /([MF])\s+(\d{1,3})/;
    const datePattern = /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i;
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
    const postalCodePattern = /[A-Z]\d[A-Z]\s*\d[A-Z]\d/i;
    
    const footerPatterns = [
        /Member List/i,
        /For Church Use Only/i,
        /Name Gender Age/i,
        /Richmond Hill Ward/i,
        /Toronto Ontario Stake/i,
        /^\d+\s*$/,
        /by Intellectual Reserve/i,
        /Page \d+/i,
        /^\s*Individuals\s*$/i
    ];

    let i = 0;
    let processedCount = 0;
    
    while (i < lines.length) {
        const line = lines[i].trim();
        
        // Skip footers and empty lines
        if (!line || footerPatterns.some(pattern => pattern.test(line))) {
            i++;
            continue;
        }

        // Try to find a name at the start of this line
        const nameMatch = line.match(namePattern);
        
        if (nameMatch) {
            let member = {
                id: crypto.randomUUID(),
                name: nameMatch[1].trim().replace(/,\s*$/, ''),
                gender: '',
                age: '',
                addressLines: [],
                phone: '',
                email: '',
                note: ''
            };

            // Extract gender/age from the same line if present
            const genderAgeMatch = line.match(genderAgePattern);
            if (genderAgeMatch) {
                member.gender = genderAgeMatch[1];
                member.age = genderAgeMatch[2];
            }

            // Look ahead for related information (up to 10 lines for safety with large files)
            let lookAheadCount = 0;
            let j = i + 1;
            let consecutiveNonAddressLines = 0;
            
            while (j < lines.length && lookAheadCount < 10) {
                const nextLine = lines[j].trim();
                
                // Skip empty lines
                if (!nextLine) {
                    j++;
                    lookAheadCount++;
                    continue;
                }
                
                // Stop if we hit another member name or footer
                if (namePattern.test(nextLine) || footerPatterns.some(p => p.test(nextLine))) {
                    break;
                }

                // Extract gender/age if not yet found
                if (!member.gender || !member.age) {
                    const gaMatch = nextLine.match(genderAgePattern);
                    if (gaMatch) {
                        member.gender = gaMatch[1];
                        member.age = gaMatch[2];
                    }
                }

                // Extract phone
                const phoneMatch = nextLine.match(phoneRegex);
                if (phoneMatch && !member.phone) {
                    member.phone = phoneMatch[0];
                }

                // Extract email
                const emailMatch = nextLine.match(emailRegex);
                if (emailMatch && !member.email) {
                    member.email = emailMatch[0];
                }

                // Collect address lines
                const isJustPhone = phoneMatch && phoneMatch[0].length >= nextLine.length - 5;
                const isJustEmail = emailMatch && emailMatch[0].length >= nextLine.length - 5;
                const hasDatePattern = datePattern.test(nextLine);
                const hasGenderAge = genderAgePattern.test(nextLine);
                
                // Check if this looks like an address line
                const looksLikeAddress = !isJustPhone && !isJustEmail && !hasDatePattern && 
                                        !hasGenderAge && nextLine.length > 3 &&
                                        (postalCodePattern.test(nextLine) || 
                                         /\d+\s+[A-Z]/.test(nextLine) || // Street number + name
                                         /\b(Ave|St|Blvd|Dr|Rd|Cir|Court|Crescent|Way)\b/i.test(nextLine) ||
                                         /\b(ON|Ontario)\b/i.test(nextLine));
                
                if (looksLikeAddress) {
                    member.addressLines.push(nextLine);
                    consecutiveNonAddressLines = 0;
                } else if (!isJustPhone && !isJustEmail && !hasDatePattern && !hasGenderAge && nextLine.length > 3) {
                    // Might still be address, but count it
                    member.addressLines.push(nextLine);
                    consecutiveNonAddressLines++;
                    
                    // If we have too many non-address-looking lines, we might be into the next member
                    if (consecutiveNonAddressLines > 2 && member.addressLines.length > 2) {
                        break;
                    }
                }

                j++;
                lookAheadCount++;
            }

            // Finalize member
            member.address = member.addressLines
                .join(', ')
                .replace(/"/g, '')
                .replace(/\s+/g, ' ')
                .replace(/,+/g, ',')
                .replace(/^,|,$/g, '')
                .trim();

            if (!member.address) {
                member.address = "No Address in PDF";
            }

            member.note = `Gender: ${member.gender || '?'}, Age: ${member.age || '?'}`;

            if (member.name) {
                members.push(member);
                processedCount++;
                
                // Log progress for large files
                if (processedCount % 50 === 0) {
                    console.log(`Parsed ${processedCount} members so far...`);
                }
            }

            // Move to the next potential member
            i = j;
        } else {
            i++;
        }
    }

    return members;
}

/**
 * Fallback PDF parsing function using Gemini API.
 * Returns both households and raw members for deduplication.
 */
export async function parsePdfWithGemini(file, geminiApiKey) {
    if (!geminiApiKey) {
        throw new Error("Advanced parsing requires a Gemini API key. Please add one in the sidebar.");
    }

    console.log("Extracting text for Gemini...");
    const pdfText = await extractPdfText(file);
    
    // Check if PDF is large - use chunked processing
    const estimatedTokens = pdfText.length / 4;
    const MAX_TOKENS = 20000;
    
    console.log(`PDF text length: ${pdfText.length} chars, estimated ${estimatedTokens.toFixed(0)} tokens`);
    
    let allMembers = [];
    
    if (estimatedTokens > MAX_TOKENS) {
        console.log(`Large PDF detected. Using chunked parsing (20 members per chunk)...`);
        allMembers = await parsePdfWithGeminiChunked(pdfText, geminiApiKey);
    } else {
        console.log("PDF is small enough for single request");
        allMembers = await parsePdfWithGeminiSingle(pdfText, geminiApiKey);
    }
    
    // Add required fields
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

/**
 * NEW: Single request Gemini parsing (for smaller PDFs)
 */
async function parsePdfWithGeminiSingle(pdfText, geminiApiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`;
    
    const prompt = `Extract all members from this church directory PDF text. Return a JSON array.

Each member needs:
- name: "Last, First" format
- gender: M or F  
- age: number as string
- address: FULL complete address (combine multi-line addresses)
- phone: phone number if present
- email: email if present

Important: Combine address lines like "123 Main St" + "CITY ON" + "A1B 2C3" into "123 Main St, CITY ON A1B 2C3"

Text:
${pdfText}

Return ONLY a JSON array, nothing else.`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8000
        }
    };

    console.log("Calling Gemini API...");
    
    try {
        const data = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;

        if (!text) {
            throw new Error("Gemini returned empty response");
        }

        return extractMembersFromJSON(text);
        
    } catch (error) {
        console.error("Gemini parsing failed:", error);
        throw error;
    }
}

/**
 * NEW: Parses large PDFs by splitting into chunks
 * IMPROVED: Returns raw members array for deduplication
 */
async function parsePdfWithGeminiChunked(pdfText, geminiApiKey) {
    console.log("Starting chunked PDF parsing...");
    
    // Split by member entries more intelligently
    const lines = pdfText.split('\n');
    const namePattern = /^[A-Z][a-z]+(?:-[A-Z][a-z]+)*,\s+[A-Za-z\s]+/;
    
    let chunks = [];
    let currentChunk = [];
    let memberCount = 0;
    const MEMBERS_PER_CHUNK = 25; // Increased to 25 for 500 members (20 chunks total)
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Check if this line starts a new member
        if (namePattern.test(line)) {
            // If we've reached the member limit, save this chunk
            if (memberCount >= MEMBERS_PER_CHUNK && currentChunk.length > 0) {
                chunks.push(currentChunk.join('\n'));
                currentChunk = [];
                memberCount = 0;
            }
            memberCount++;
        }
        
        currentChunk.push(lines[i]);
    }
    
    // Add the last chunk
    if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
    }
    
    console.log(`Split PDF into ${chunks.length} chunks (~${MEMBERS_PER_CHUNK} members each)`);
    
    // Process each chunk with simpler prompt
    let allMembers = [];
    let failedChunks = 0;
    
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing chunk ${i + 1}/${chunks.length}...`);
        
        // Report progress to UI if callback exists
        if (window.geminiChunkProgress) {
            window.geminiChunkProgress(i + 1, chunks.length, allMembers.length);
        }
        
        try {
            const chunkMembers = await processGeminiChunk(chunks[i], geminiApiKey, i + 1, chunks.length);
            
            if (chunkMembers && chunkMembers.length > 0) {
                allMembers = allMembers.concat(chunkMembers);
                console.log(`✓ Chunk ${i + 1} yielded ${chunkMembers.length} members. Total: ${allMembers.length}`);
            } else {
                console.warn(`✗ Chunk ${i + 1} returned no members`);
                failedChunks++;
            }
            
            // Delay between chunks to avoid rate limiting
            if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            
        } catch (chunkError) {
            console.error(`✗ Error processing chunk ${i + 1}:`, chunkError.message);
            failedChunks++;
            
            // If too many chunks are failing, stop
            if (failedChunks > chunks.length * 0.3) { // More than 30% failed
                throw new Error(`Too many chunks failed (${failedChunks}/${i + 1}). Stopping.`);
            }
        }
    }
    
    console.log(`Chunked parsing complete. Total members: ${allMembers.length} (${failedChunks} chunks failed)`);
    
    if (allMembers.length === 0) {
        throw new Error("No members extracted from any chunks");
    }
    
    return allMembers;
}

/**
 * NEW: Process a single chunk with Gemini
 * Simplified for better reliability
 */
async function processGeminiChunk(chunkText, geminiApiKey, chunkNum, totalChunks) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`;
    
    const prompt = `Extract members from this church directory text. Return a JSON array.

Each member object needs:
- name: "Last, First" format
- gender: M or F
- age: number as string
- address: complete address (combine multiple lines)
- phone: phone number if present
- email: email if present

Combine address lines like "123 Main St" + "CITY ON" + "A1B 2C3" into "123 Main St, CITY ON A1B 2C3"

Text to parse:
${chunkText}

Return ONLY the JSON array, nothing else.`;

    const payload = {
        contents: [{ 
            parts: [{ text: prompt }] 
        }],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8000
        }
    };
    
    const data = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    
    if (!text) {
        console.error(`Chunk ${chunkNum} returned no text`);
        return [];
    }
    
    return extractMembersFromJSON(text);
}

/**
 * NEW: Helper to extract and parse JSON from Gemini response
 */
function extractMembersFromJSON(text) {
    // Clean and parse JSON
    let cleanText = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
    
    // Find the JSON array in the response
    const arrayStart = cleanText.indexOf('[');
    const arrayEnd = cleanText.lastIndexOf(']');
    
    if (arrayStart === -1 || arrayEnd === -1) {
        console.error("No JSON array found in response");
        console.log("Response preview:", cleanText.substring(0, 200));
        return [];
    }
    
    cleanText = cleanText.substring(arrayStart, arrayEnd + 1);
    
    try {
        const members = JSON.parse(cleanText);
        
        if (!Array.isArray(members)) {
            console.error("Response is not an array");
            return [];
        }
        
        return members;
        
    } catch (parseError) {
        console.error("JSON parse error:", parseError.message);
        console.log("Failed text preview:", cleanText.substring(0, 200));
        return [];
    }
}

/**
 * NEW: Deduplicates members from local and Gemini parsing
 * Keeps local parser results, adds unique Gemini results
 */
export function deduplicateMembers(localMembers, geminiMembers) {
    console.log(`Deduplicating: ${localMembers.length} local + ${geminiMembers.length} Gemini`);
    
    const seen = new Set();
    const deduplicated = [];
    
    // Helper to create a unique key for a member
    const getMemberKey = (member) => {
        const name = (member.name || '').trim().toLowerCase();
        // Use first part of address to avoid issues with minor differences
        const addressPart = (member.address || '').split(',')[0].trim().toLowerCase();
        return `${name}|${addressPart}`;
    };
    
    // Add all local parser results first (they have priority)
    for (const member of localMembers) {
        const key = getMemberKey(member);
        if (!seen.has(key)) {
            seen.add(key);
            deduplicated.push(member);
        }
    }
    
    const localCount = deduplicated.length;
    
    // Add unique Gemini results
    for (const member of geminiMembers) {
        const key = getMemberKey(member);
        if (!seen.has(key)) {
            seen.add(key);
            deduplicated.push(member);
        }
    }
    
    const geminiAddedCount = deduplicated.length - localCount;
    
    console.log(`Deduplication complete: ${deduplicated.length} unique members`);
    console.log(`  - From local parser: ${localCount}`);
    console.log(`  - Added from Gemini: ${geminiAddedCount}`);
    console.log(`  - Duplicates skipped: ${(localMembers.length + geminiMembers.length) - deduplicated.length}`);
    
    return deduplicated;
}

/**
 * Groups members into households based on their address
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
                    address: member.address,
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