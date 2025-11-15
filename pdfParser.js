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
 * IMPROVED: Parses the reconstructed lines into member objects.
 * Uses a more flexible approach that handles multi-line entries better.
 * Enhanced to handle larger files more reliably.
 */
function parseMemberLines(lines) {
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

    console.log(`Parsed ${members.length} members from PDF (local parser)`);
    return groupMembersIntoHouseholds(members);
}

/**
 * Fallback PDF parsing function using Gemini API.
 * IMPROVED: Handles large PDFs by chunking and includes better error handling
 */
export async function parsePdfWithGemini(file, geminiApiKey) {
    if (!geminiApiKey) {
        throw new Error("Advanced parsing requires a Gemini API key. Please add one in the sidebar.");
    }

    console.log("Extracting text for Gemini...");
    const pdfText = await extractPdfText(file);
    
    // Check if PDF is very large - if so, try chunked processing
    const estimatedTokens = pdfText.length / 4; // Rough estimate: 1 token ≈ 4 chars
    const MAX_TOKENS = 30000; // Conservative limit for input
    
    if (estimatedTokens > MAX_TOKENS) {
        console.log(`Large PDF detected (${estimatedTokens.toFixed(0)} estimated tokens). Using chunked parsing...`);
        return await parsePdfWithGeminiChunked(pdfText, geminiApiKey);
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`;
    
    const systemPrompt = `You are an expert data extraction tool. Parse the provided text from a PDF member directory and convert it into a valid JSON array. Each object in the array should represent one person.

IMPORTANT INSTRUCTIONS:
- Extract COMPLETE addresses by combining multi-line address information
- Addresses typically span 2-4 lines (street, city/province, postal code)
- Name format: "Last, First" or "Last, First Middle"
- Gender is typically M or F
- Age is typically a 1-3 digit number
- If a value is missing, use an empty string ""
- Carefully separate different people's information
- CRITICAL: Return ONLY valid JSON, no additional text or formatting

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
    
    const userQuery = `Extract all members from the following text into a JSON array. Pay special attention to:
1. Combining multi-line addresses into complete, full addresses
2. Separating different people correctly (each person typically has Name, Gender, Age, Birth Date on separate lines)
3. Including complete postal codes in addresses

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
                    required: ["name"]
                }
            }
        }
    };

    console.log("Calling Gemini API for advanced parsing...");
    
    try {
        const data = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;

        if (!text) {
            console.error("Gemini parsing returned no data.", data);
            throw new Error("Gemini returned empty response");
        }

        // Try to parse the JSON
        let members;
        try {
            members = JSON.parse(text);
        } catch (jsonError) {
            console.error("JSON parse error. Attempting to clean and retry...", jsonError);
            console.log("Raw response (first 500 chars):", text.substring(0, 500));
            
            // Try to clean the JSON
            let cleanedText = text
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .replace(/,\s*]/g, ']')
                .replace(/,\s*}/g, '}')
                .trim();
            
            try {
                members = JSON.parse(cleanedText);
            } catch (secondError) {
                console.error("Still unable to parse after cleaning:", secondError);
                throw new Error("Gemini returned invalid JSON format. The PDF may be too large or complex.");
            }
        }

        if (!Array.isArray(members)) {
            throw new Error("Gemini response is not an array");
        }

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
        
    } catch (error) {
        console.error("Gemini parsing failed:", error);
        throw new Error(`Gemini parsing failed: ${error.message}`);
    }
}

/**
 * NEW: Parses large PDFs by splitting into chunks
 */
async function parsePdfWithGeminiChunked(pdfText, geminiApiKey) {
    console.log("Starting chunked PDF parsing...");
    
    // Split text into member blocks (look for name patterns)
    const lines = pdfText.split('\n');
    const namePattern = /^[A-Z][a-z]+(?:-[A-Z][a-z]+)*,\s+[A-Za-z\s]+/;
    
    let chunks = [];
    let currentChunk = [];
    let chunkSize = 0;
    const MAX_CHUNK_SIZE = 20000; // Characters per chunk
    
    for (const line of lines) {
        const lineSize = line.length;
        
        // If this line starts a new member and we're over the chunk size, start new chunk
        if (namePattern.test(line.trim()) && chunkSize > MAX_CHUNK_SIZE && currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n'));
            currentChunk = [];
            chunkSize = 0;
        }
        
        currentChunk.push(line);
        chunkSize += lineSize;
    }
    
    // Add the last chunk
    if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
    }
    
    console.log(`Split PDF into ${chunks.length} chunks`);
    
    // Process each chunk
    let allMembers = [];
    
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Processing chunk ${i + 1}/${chunks.length}...`);
        
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`;
        
        const payload = {
            contents: [{ 
                parts: [{ 
                    text: `Extract all members from this member directory text. Return a JSON array of objects with: name, gender, age, address, phone, email. Combine multi-line addresses.\n\n${chunks[i]}` 
                }] 
            }],
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
                        required: ["name"]
                    }
                }
            }
        };
        
        try {
            const data = await fetchWithRetry(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            const candidate = data.candidates?.[0];
            const text = candidate?.content?.parts?.[0]?.text;
            
            if (text) {
                const chunkMembers = JSON.parse(text);
                if (Array.isArray(chunkMembers)) {
                    allMembers = allMembers.concat(chunkMembers);
                    console.log(`Chunk ${i + 1} yielded ${chunkMembers.length} members. Total so far: ${allMembers.length}`);
                }
            }
            
            // Small delay between chunks to avoid rate limiting
            if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
        } catch (chunkError) {
            console.error(`Error processing chunk ${i + 1}:`, chunkError);
            // Continue with other chunks
        }
    }
    
    console.log(`Chunked parsing complete. Total members: ${allMembers.length}`);
    
    // Add required fields
    allMembers.forEach(m => {
        m.id = crypto.randomUUID();
        m.note = `Gender: ${m.gender || '?'}, Age: ${m.age || '?'}`;
        if (!m.address || !m.address.trim()) {
            m.address = "No Address in PDF";
        }
    });
    
    return groupMembersIntoHouseholds(allMembers);
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