/**
 * services.js - FIXED VERSION
 *
 * This file contains all logic related to external APIs:
 * - Geocoding (Gemini and Nominatim)
 * - API Key and Region storage
 * - fetchWithRetry helper
 */

// --- API Key Functions ---

export function loadApiKey() {
    return localStorage.getItem('geminiApiKey') || '';
}

export function saveApiKey() {
    const keyInput = document.getElementById('api-key-input');
    const geminiApiKey = keyInput.value.trim();
    localStorage.setItem('geminiApiKey', geminiApiKey);
    
    const status = document.getElementById('api-key-status');
    status.textContent = 'API Key saved!';
    status.classList.remove('hidden');
    setTimeout(() => status.classList.add('hidden'), 2000);

    return geminiApiKey;
}

// --- NEW: Search Region Functions ---

export function loadSearchRegion() {
    return localStorage.getItem('searchRegion') || 'Ontario, Canada'; // Default to Ontario
}

export function saveSearchRegion() {
    const regionInput = document.getElementById('search-region-input');
    const searchRegion = regionInput.value.trim();
    localStorage.setItem('searchRegion', searchRegion);
    
    const status = document.getElementById('search-region-status');
    status.textContent = 'Region saved!';
    status.classList.remove('hidden');
    setTimeout(() => status.classList.add('hidden'), 2000);

    return searchRegion;
}

// --- Geocoding Functions ---

/**
 * Main geocoding function.
 * Tries to use Gemini if an API key is provided, otherwise falls back to Nominatim.
 * --- FIX: Accepts searchRegion for context ---
 */
export async function geocodeAddress(household, geminiApiKey, searchRegion) {
    if (!household.address || household.address === 'No Address in PDF') {
        return household;
    }

    try {
        if (geminiApiKey) {
            console.log(`Geocoding (Gemini) [Region: ${searchRegion}]: ${household.address}`);
            return await geocodeWithGemini(household, geminiApiKey, searchRegion);
        } else {
            console.log(`Geocoding (Nominatim) [Region: ${searchRegion}]: ${household.address}`);
            return await geocodeWithNominatim(household, searchRegion);
        }
    } catch (error) {
        console.error(`Geocoding failed for ${household.address}:`, error.message);
        return household;
    }
}

/**
 * Geocoding with Nominatim (OpenStreetMap).
 * --- FIX: Uses dynamic searchRegion ---
 */
async function geocodeWithNominatim(household, searchRegion) {
    // Add region to improve accuracy
    const addressQuery = `${household.address}, ${searchRegion}`;
    
    // --- FIX: Add viewbox based on map default and limit results to region ---
    const viewbox = '-79.55,43.78,-79.25,43.95'; // Default Richmond Hill area
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressQuery)}&limit=1&addressdetails=1&viewbox=${viewbox}&bounded=1`;
    
    try {
        const data = await fetchWithRetry(url, {
            headers: {
                'User-Agent': 'GroupOrganizerApp/1.0'
            }
        });
        
        if (data && data.length > 0) {
            const result = data[0];
            console.log(`Nominatim found: ${result.display_name}`);
            return {
                ...household,
                coords: [parseFloat(result.lat), parseFloat(result.lon)]
            };
        } else {
            // --- FALLBACK: Try without the viewbox if nothing was found
            console.log("Nominatim failed with viewbox, trying without...");
            const fallbackUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressQuery)}&limit=1&addressdetails=1`;
            const fallbackData = await fetchWithRetry(fallbackUrl, {
                headers: { 'User-Agent': 'GroupOrganizerApp/1.0' }
            });
            if (fallbackData && fallbackData.length > 0) {
                 const result = fallbackData[0];
                 console.log(`Nominatim fallback found: ${result.display_name}`);
                 return {
                    ...household,
                    coords: [parseFloat(result.lat), parseFloat(result.lon)]
                 };
            }
        }
    } catch (error) {
        console.error(`Nominatim geocoding failed for ${household.address}:`, error);
    }
    return household;
}

/**
 * Geocoding with Google's Gemini API.
 * --- FIX: Use production model and dynamic searchRegion ---
 */
async function geocodeWithGemini(household, geminiApiKey, searchRegion) {
    // --- FIX: Use stable production model ---
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;
    
    // CRITICAL: Improved prompt for pinpoint accuracy
    const systemPrompt = `You are a precise geocoding expert. Your task is to provide EXACT latitude and longitude coordinates for street addresses.

REQUIREMENTS:
1. Return coordinates for the EXACT street address, not the city center or general area.
2. Use the most precise location data available (rooftop level if possible).
3. --- USE THIS REGION CONTEXT: ${searchRegion} ---
4. Format: Return ONLY a JSON object with "lat" and "lon" as decimal numbers.
5. Use at least 6 decimal places for precision (e.g., 43.850000, -79.400000).

Example Request:
Address: "58 Morgan Ave, Thornhill ON L3T 1R2"
Region: "Ontario, Canada"
Response: {"lat": 43.821234, "lon": -79.416789}`;

    const userQuery = `Find the EXACT geocoordinates for this address:

${household.address}

Use the provided region context: ${searchRegion}

Return precise coordinates with at least 6 decimal places.`;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    "lat": { "type": "NUMBER" },
                    "lon": { "type": "NUMBER" }
                },
                required: ["lat", "lon"]
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
            const coords = JSON.parse(text);
            if (coords && coords.lat != null && coords.lon != null) {
                console.log(`Gemini geocoded: ${household.address} -> [${coords.lat}, ${coords.lon}]`);
                return {
                    ...household,
                    coords: [parseFloat(coords.lat), parseFloat(coords.lon)]
                };
            }
        }
        
        console.log(`Gemini failed, falling back to Nominatim for: ${household.address}`);
        return await geocodeWithNominatim(household, searchRegion);

    } catch (error) {
        console.error(`Gemini geocoding failed for ${household.address}:`, error);
        console.log(`Falling back to Nominatim for: ${household.address}`);
        return await geocodeWithNominatim(household, searchRegion);
    }
}

/**
 * Helper function for fetch with exponential backoff.
 */
export async function fetchWithRetry(url, options, maxRetries = 3) {
    let attempt = 0;
    let delay = 1000;

    while (attempt < maxRetries) {
        try {
            const response = await fetch(url, options);

            if (response.status === 429) {
                console.warn(`Rate limit hit (429). Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
                attempt++;
            } else if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            } else {
                return await response.json();
            }
        } catch (error) {
            console.error(`Fetch attempt ${attempt + 1} failed:`, error.message);
            if (attempt + 1 >= maxRetries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
            attempt++;
        }
    }
    throw new Error('Max retries reached.');
}
