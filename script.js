/**
 * script.js
 *
 * Main application logic file.
 * Handles DOM, UI rendering, state management, and event listeners.
 * Imports functions from services.js and pdfParser.js.
 */

// --- Import Modules ---
// --- FIX: Import new region functions ---
import { loadApiKey, saveApiKey, geocodeAddress, loadSearchRegion, saveSearchRegion } from './services.js';
// FIX: Import both parser functions
import { parsePdfMembers, parsePdfWithGemini } from './pdfParser.js'; 

// --- DOM ELEMENT REFERENCES ---
const loginOverlay = document.getElementById('login-overlay');
const appContainer = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password');
const loginError = document.getElementById('login-error');
const searchInput = document.getElementById('search-input');
const groupList = document.getElementById('group-list');
const exportButton = document.getElementById('export-button');
const importButton = document.getElementById('import-button');
const addGroupButton = document.getElementById('add-group-button'); // New Button
const pdfFileInput = document.getElementById('pdf-file-input');
const importModal = document.getElementById('import-modal');
const startImportBtn = document.getElementById('start-import');
const cancelImportBtn = document.getElementById('cancel-import');
const importStatus = document.getElementById('import-status');
const importMessage = document.getElementById('import-message');
const importProgress = document.getElementById('import-progress');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');

// --- Filter DOM References ---
let filterGender = null;
let filterMinAge = null;
let filterMaxAge = null;
let filterHasContact = null;

// --- GLOBAL STATE ---
let groupsData = [];
let draggedItem = null;
let mapMarkers = {};
let selectedPdfFile = null;
let geminiApiKey = ''; // API Key variable
let searchRegion = ''; // --- NEW: Search Region variable
let map = null; // Map will be initialized after login
const groupColors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#42d4f4', '#d2f53c', '#f032e6', '#fabebe', '#0082c8', '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', ''];

// --- Filter State ---
let currentFilters = {
    gender: 'any',
    minAge: 0,
    maxAge: 99,
    hasContact: false
};

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- DATA PERSISTENCE ---
function loadData() {
    const savedData = localStorage.getItem('groupsData');
    let data = savedData ? JSON.parse(savedData) : [];
    
    // Ensure FA Pool always exists
    let faPool = data.find(g => g.isFAPool);
    if (!faPool) {
        faPool = { group: "FA Pool", caregivers: [], members: [], isFAPool: true };
        data.push(faPool);
    }

    // Ensure all households have IDs
    data.forEach(group => {
        [...group.caregivers, ...group.members].forEach(household => {
            if (!household.id) {
                household.id = crypto.randomUUID();
            }
        });
    });
    groupsData = data;
    saveData(); // Save back to ensure FA pool is stored
}

function saveData() {
    localStorage.setItem('groupsData', JSON.stringify(groupsData));
}

// --- LOGIN LOGIC ---
loginForm.addEventListener('submit', function(e) {
    e.preventDefault();
    if (passwordInput.value === '0406') {
        loginOverlay.classList.add('hidden');
        appContainer.classList.remove('hidden');
        initializeApp();
        setTimeout(() => map.invalidateSize(), 10);
    } else {
        loginError.classList.remove('hidden');
        passwordInput.value = '';
    }
});

// --- INITIALIZATION ---
function initializeApp() {
    loadData();
    
    // --- FIX: Initialize map *after* login, when the div is visible ---
    map = L.map('map'); 
    
    map.setView([43.85, -79.4], 11); // Richmond Hill area
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // --- Inject Filter HTML ---
    const searchContainer = searchInput.parentElement;
    const filterHtml = `
            <div id="filter-container" class="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
                <h4 class="font-semibold text-sm text-gray-700 mb-2">Filters</h4>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label for="filter-gender" class="block text-xs font-medium text-gray-600">Gender</label>
                        <select id="filter-gender" class="mt-1 block w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50">
                            <option value="any">Any</option>
                            <option value="M">Male</option>
                            <option value="F">Female</option>
                        </select>
                    </div>
                    <div class="flex items-end">
                        <div class="flex items-center h-full">
                            <input id="filter-has-contact" type="checkbox" class="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500">
                            <label for="filter-has-contact" class="ml-2 block text-xs font-medium text-gray-700">Has Full Contact</label>
                        </div>
                    </div>
                    <div>
                        <label for="filter-min-age" class="block text-xs font-medium text-gray-600">Min Age</label>
                        <input type="number" id="filter-min-age" value="0" min="0" class="mt-1 block w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50">
                    </div>
                    <div>
                        <label for="filter-max-age" class="block text-xs font-medium text-gray-600">Max Age</label>
                        <input type="number" id="filter-max-age" value="99" min="0" class="mt-1 block w-full text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50">
                    </div>
                </div>
            </div>
        `;
    searchContainer.insertAdjacentHTML('afterend', filterHtml);

    // --- Inject API Key HTML ---
    const filterContainer = document.getElementById('filter-container');
    const apiKeyHtml = `
            <div id="api-key-container" class="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
                <h4 class="font-semibold text-sm text-gray-700 mb-2">Gemini API Key (Optional)</h4>
                <label for="api-key-input" class="block text-xs font-medium text-gray-600">For better geocoding & parsing</label>
                <input type="password" id="api-key-input" class="mt-1 block w-full text-sm border-gray-300 rounded-md shadow-sm">
                <button id="save-api-key" class="mt-2 w-full text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-1 px-2 rounded-lg">Save Key</button>
                <p id="api-key-status" class="text-xs text-green-600 mt-1 hidden"></p>
            </div>
        `;
    filterContainer.insertAdjacentHTML('afterend', apiKeyHtml);

    // --- NEW: Inject Search Region HTML ---
    const apiKeyContainer = document.getElementById('api-key-container');
    const searchRegionHtml = `
            <div id="search-region-container" class="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
                <h4 class="font-semibold text-sm text-gray-700 mb-2">Search Region</h4>
                <label for="search-region-input" class="block text-xs font-medium text-gray-600">Context for geocoding (e.g., "Ontario, Canada")</label>
                <input type="text" id="search-region-input" class="mt-1 block w-full text-sm border-gray-300 rounded-md shadow-sm">
                <button id="save-search-region" class="mt-2 w-full text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold py-1 px-2 rounded-lg">Save Region</button>
                <p id="search-region-status" class="text-xs text-green-600 mt-1 hidden"></p>
            </div>
        `;
    apiKeyContainer.insertAdjacentHTML('afterend', searchRegionHtml);


    // --- Load API Key and add listener ---
    geminiApiKey = loadApiKey();
    const apiKeyInput = document.getElementById('api-key-input');
    if (geminiApiKey) {
        apiKeyInput.value = geminiApiKey;
    }
    document.getElementById('save-api-key').addEventListener('click', () => {
        geminiApiKey = saveApiKey(); // Update state variable with saved key
    });

    // --- NEW: Load Search Region and add listener ---
    searchRegion = loadSearchRegion();
    const searchRegionInput = document.getElementById('search-region-input');
    searchRegionInput.value = searchRegion;
    document.getElementById('save-search-region').addEventListener('click', () => {
        searchRegion = saveSearchRegion(); // Update state variable with saved region
    });


    // --- Assign Filter DOM References ---
    filterGender = document.getElementById('filter-gender');
    filterMinAge = document.getElementById('filter-min-age');
    filterMaxAge = document.getElementById('filter-max-age');
    filterHasContact = document.getElementById('filter-has-contact');

    // --- Filter Event Listeners ---
    function updateFiltersAndRender() {
        currentFilters.gender = filterGender.value;
        currentFilters.minAge = parseInt(filterMinAge.value, 10) || 0;
        currentFilters.maxAge = parseInt(filterMaxAge.value, 10) || 99;
        currentFilters.hasContact = filterHasContact.checked;
        renderApp();
    }

    filterGender.addEventListener('change', updateFiltersAndRender);
    filterMinAge.addEventListener('input', updateFiltersAndRender);
    filterMaxAge.addEventListener('input', updateFiltersAndRender);
    filterHasContact.addEventListener('change', updateFiltersAndRender);

    // --- Main Button Listeners ---
    exportButton.addEventListener('click', handleExport);
    importButton.addEventListener('click', () => pdfFileInput.click());
    addGroupButton.addEventListener('click', addNewGroup); // New listener
    pdfFileInput.addEventListener('change', handlePdfSelection);
    startImportBtn.addEventListener('click', handleImport);
    cancelImportBtn.addEventListener('click', closeImportModal);

    searchInput.addEventListener('input', renderApp);

    // Add dynamic style for household address cursor
    const styleSheet = document.createElement("style");
    styleSheet.type = "text/css";
    styleSheet.innerText = ".household-address:hover { text-decoration: underline; }";
    document.head.appendChild(styleSheet);

    renderApp();
    loader.style.display = 'none';
}

// --- PDF IMPORT LOGIC ---
function handlePdfSelection(e) {
    const file = e.target.files[0];
    if (file && file.type === 'application/pdf') {
        selectedPdfFile = file;
        console.log("PDF file selected:", file.name);
        showImportModal();
    }
    pdfFileInput.value = '';
}

function showImportModal() {
    importModal.classList.remove('hidden');
    importModal.classList.add('flex');
    importStatus.classList.add('hidden');
    importProgress.classList.add('hidden');
    startImportBtn.disabled = false;
    cancelImportBtn.disabled = false;
}

function closeImportModal() {
    importModal.classList.add('hidden');
    importModal.classList.remove('flex');
    selectedPdfFile = null;
}

// --- handleImport MODIFIED FOR GEMINI-ONLY PARSING ---
async function handleImport() {
    if (!selectedPdfFile) {
        console.error("No PDF file selected.");
        return;
    }

    // --- NEW: Check for API key *first* ---
    if (!geminiApiKey) {
        showStatus('Error: Gemini parsing requires an API key. Please add one in the sidebar.', 'error');
        startImportBtn.disabled = false;
        cancelImportBtn.disabled = false;
        return; 
    }

    console.log("Starting import process with Gemini-only parsing...");

    startImportBtn.disabled = true;
    cancelImportBtn.disabled = true;
    importProgress.classList.remove('hidden');

    try {
        showStatus('Processing PDF with Gemini parser...', 'info');
        updateProgress(10, 'Reading PDF for advanced parsing...');

        console.log("Parsing PDF members with Gemini...");
        
        // --- CHANGED: Call Gemini parser directly ---
        // The local parsePdfMembers() call has been removed.
        let households = await parsePdfWithGemini(selectedPdfFile, geminiApiKey); // From pdfParser.js

        // --- FINAL CHECK ---
        if (households.length === 0) {
            throw new Error("Gemini parsing failed. Unable to import members. Please check the PDF format or your API key.");
        }
        
        updateProgress(30, `Found ${households.length} households. Geocoding addresses...`);
        console.log(`Found ${households.length} "household" objects.`);

        const {geocodedHouseholds, unassignedHouseholds} = await geocodeHouseholds(households);
        updateProgress(80, 'Creating groups...');

        console.log("Organizing into groups...");
        const { newGroups, outlierHouseholds } = await organizeIntoGroups(geocodedHouseholds);
        updateProgress(90, 'Finalizing...');
        console.log(`Created ${newGroups.length} groups.`);

        const faPool = groupsData.find(g => g.isFAPool);
        faPool.members.push(...unassignedHouseholds, ...outlierHouseholds);
        
        groupsData = [faPool, ...newGroups];
        saveData();

        updateProgress(100, 'Import complete!');
        showStatus('Successfully imported and geocoded member data!', 'success');

        setTimeout(() => {
            closeImportModal();
            startImportBtn.disabled = false;
            cancelImportBtn.disabled = false;
        }, 1500);

        console.log("Import complete, rendering app...");
        renderApp();

    } catch (error) {
        console.error('Import error:', error);
        showStatus(`Error: ${error.message}`, 'error');
        startImportBtn.disabled = false;
        cancelImportBtn.disabled = false;
        importProgress.classList.add('hidden'); // Hide progress bar on failure
    }
}

/**
 * Geocode all households in the list.
 */
async function geocodeHouseholds(households) {
    const geocodedHouseholds = [];
    const householdsToGeocode = households.filter(h => h.address && h.address !== 'No Address in PDF');
    const unassignedHouseholds = households.filter(h => !h.address || h.address === 'No Address in PDF');

    console.log(`Geocoding ${householdsToGeocode.length} households...`);

    for (let i = 0; i < householdsToGeocode.length; i++) {
        const household = householdsToGeocode[i];
        const progress = Math.floor((i / householdsToGeocode.length) * 50) + 30;
        updateProgress(progress, `Geocoding ${i + 1} of ${householdsToGeocode.length} addresses...`);

        // --- FIX: Pass searchRegion to the geocoder ---
        const geocodedHousehold = await geocodeAddress(household, geminiApiKey, searchRegion); // From services.js
        geocodedHouseholds.push(geocodedHousehold);
        
        // Add a small delay to avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 50)); 
    }

    // Add back any households that had coords but failed geocoding
    const failedGeocodes = geocodedHouseholds.filter(h => !h.coords);
    const successfulGeocodes = geocodedHouseholds.filter(h => h.coords);

    console.log(`Finished geocoding. ${successfulGeocodes.length} successful, ${failedGeocodes.length + unassignedHouseholds.length} unassigned.`);

    return {
        geocodedHouseholds: successfulGeocodes, 
        unassignedHouseholds: [...unassignedHouseholds, ...failedGeocodes]
    };
}


/**
 * Organizes households into groups using K-means clustering
 * and separates outliers.
 */
/**
 * FIXED: Organizes households into groups using K-means clustering
 * TARGET: 5-6 households per group (2 caregivers + 3-4 assigned)
 * * Replace the organizeIntoGroups function in script.js with this version
 */
async function organizeIntoGroups(geocodedHouseholds) {
    if (geocodedHouseholds.length < 5) {
        console.log("Too few households to cluster, adding all to FA Pool.");
        return { newGroups: [], outlierHouseholds: geocodedHouseholds };
    }

    // --- 1. Find Outliers ---
    let sumLat = 0;
    let sumLon = 0;
    geocodedHouseholds.forEach(h => {
        sumLat += h.coords[0];
        sumLon += h.coords[1];
    });
    const meanCenter = [sumLat / geocodedHouseholds.length, sumLon / geocodedHouseholds.length];

    // Calculate distance for each household from mean center
    const distances = geocodedHouseholds.map(h => {
        return getDistance(h.coords, meanCenter);
    }).sort((a, b) => a - b);

    // Calculate IQR (Interquartile Range) for outlier detection
    const q1Index = Math.floor(distances.length / 4);
    const q3Index = Math.floor(distances.length * 3 / 4);
    const Q1 = distances[q1Index];
    const Q3 = distances[q3Index];
    const IQR = Q3 - Q1;
    const outlierThreshold = Q3 + (1.5 * IQR);

    console.log(`Clustering stats: Mean Center [${meanCenter[0].toFixed(4)}, ${meanCenter[1].toFixed(4)}], Outlier Threshold > ${outlierThreshold.toFixed(2)}km`);

    // Separate outliers
    const mainClusterHouseholds = [];
    const outlierHouseholds = [];
    geocodedHouseholds.forEach(h => {
        const dist = getDistance(h.coords, meanCenter);
        if (dist > outlierThreshold) {
            outlierHouseholds.push(h);
        } else {
            mainClusterHouseholds.push(h);
        }
    });

    console.log(`Found ${mainClusterHouseholds.length} main households and ${outlierHouseholds.length} outliers.`);

    if (mainClusterHouseholds.length < 5) {
        return { newGroups: [], outlierHouseholds: [...mainClusterHouseholds, ...outlierHouseholds] };
    }

    // --- 2. FIXED: Calculate optimal K for target group size ---
    // Target: 5-6 households per group
    const TARGET_SIZE = 5.5; // Average of 5-6
    const K = Math.max(1, Math.round(mainClusterHouseholds.length / TARGET_SIZE));
    
    console.log(`Creating ${K} groups for ${mainClusterHouseholds.length} households (target: ${TARGET_SIZE} per group)`);

    // --- 3. K-means++ initialization (better than random) ---
    let centroids = getKMeansPlusPlusCentroids(mainClusterHouseholds, K);
    let clusters = new Array(K).fill(0).map(() => []);
    let iterations = 0;
    let changed = true;
    const MAX_ITERATIONS = 50; // Increased for better convergence

    while (changed && iterations < MAX_ITERATIONS) {
        changed = false;
        clusters = new Array(K).fill(0).map(() => []);
        
        // Assign households to nearest centroid
        for (const household of mainClusterHouseholds) {
            let minDistance = Infinity;
            let clusterIndex = 0;
            for (let i = 0; i < centroids.length; i++) {
                const distance = getDistance(household.coords, centroids[i]);
                if (distance < minDistance) {
                    minDistance = distance;
                    clusterIndex = i;
                }
            }
            clusters[clusterIndex].push(household);
        }

        // Recalculate centroids
        const newCentroids = [];
        for (let i = 0; i < clusters.length; i++) {
            const cluster = clusters[i];
            if (cluster.length > 0) {
                let sumLat = 0;
                let sumLon = 0;
                for (const h of cluster) {
                    sumLat += h.coords[0];
                    sumLon += h.coords[1];
                }
                const newCentroid = [sumLat / cluster.length, sumLon / cluster.length];

                if (!centroids[i] || getDistance(newCentroid, centroids[i]) > 0.0001) {
                    changed = true;
                }
                newCentroids.push(newCentroid);
            } else {
                // Re-seed empty cluster
                newCentroids.push(centroids[i]);
            }
        }
        centroids = newCentroids;
        iterations++;
    }

    console.log(`Clustering converged in ${iterations} iterations.`);

    // --- 4. Balance clusters to maintain 5-6 household target ---
    clusters = balanceClusters(clusters, centroids);

    // --- 5. Create groups from balanced clusters ---
    const groups = [];
    let groupCounter = 1;
    
    for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        if (cluster.length === 0) continue;

        // Sort by distance from centroid (closest first)
        cluster.sort((a, b) => {
            const distA = getDistance(a.coords, centroids[i]);
            const distB = getDistance(b.coords, centroids[i]);
            return distA - distB;
        });

        // FIXED: Assign 2 caregivers, rest as members
        const caregivers = cluster.slice(0, 2);
        const members = cluster.slice(2);

        groups.push({
            group: groupCounter++,
            caregivers: caregivers,
            members: members,
            isFAPool: false
        });

        console.log(`Group ${groupCounter - 1}: ${caregivers.length} caregivers + ${members.length} members = ${cluster.length} total`);
    }
    
    return { newGroups: groups, outlierHouseholds: outlierHouseholds };
}

/**
 * K-means++ initialization for better clustering
 * This chooses initial centroids that are far apart
 */
function getKMeansPlusPlusCentroids(households, k) {
    const centroids = [];
    
    // Choose first centroid randomly
    const firstIndex = Math.floor(Math.random() * households.length);
    centroids.push(households[firstIndex].coords);
    
    // Choose remaining centroids
    for (let i = 1; i < k; i++) {
        const distances = households.map(h => {
            // Find minimum distance to existing centroids
            let minDist = Infinity;
            for (const centroid of centroids) {
                const dist = getDistance(h.coords, centroid);
                minDist = Math.min(minDist, dist);
            }
            return minDist;
        });
        
        // Choose household with maximum minimum distance (farthest from all centroids)
        let maxDist = -1;
        let maxIndex = 0;
        distances.forEach((d, idx) => {
            if (d > maxDist) {
                maxDist = d;
                maxIndex = idx;
            }
        });
        
        centroids.push(households[maxIndex].coords);
    }
    
    return centroids;
}

/**
 * Balance clusters to ensure they're close to target size (5-6 households)
 */
function balanceClusters(clusters, centroids) {
    const TARGET_MIN = 5;
    const TARGET_MAX = 7;
    
    // Find oversized and undersized clusters
    let changed = true;
    let iterations = 0;
    
    while (changed && iterations < 10) {
        changed = false;
        
        for (let i = 0; i < clusters.length; i++) {
            const cluster = clusters[i];
            
            // If cluster is too large, move farthest households to nearest cluster
            if (cluster.length > TARGET_MAX) {
                // Sort by distance (farthest last)
                cluster.sort((a, b) => {
                    const distA = getDistance(a.coords, centroids[i]);
                    const distB = getDistance(b.coords, centroids[i]);
                    return distA - distB;
                });
                
                // Move excess households
                while (cluster.length > TARGET_MAX) {
                    const household = cluster.pop(); // Remove farthest
                    
                    // Find nearest cluster that isn't too large
                    let minDist = Infinity;
                    let targetClusterIdx = -1;
                    
                    for (let j = 0; j < clusters.length; j++) {
                        if (i === j || clusters[j].length >= TARGET_MAX) continue;
                        
                        const dist = getDistance(household.coords, centroids[j]);
                        if (dist < minDist) {
                            minDist = dist;
                            targetClusterIdx = j;
                        }
                    }
                    
                    if (targetClusterIdx !== -1) {
                        clusters[targetClusterIdx].push(household);
                        changed = true;
                    } else {
                        // No suitable cluster found, keep it
                        cluster.push(household);
                        break;
                    }
                }
            }
        }
        
        iterations++;
    }
    
    // Remove empty clusters
    return clusters.filter(c => c.length > 0);
}

function showStatus(message, type) {
    importStatus.classList.remove('hidden', 'bg-blue-100', 'bg-green-100', 'bg-red-100', 'text-blue-800', 'text-green-800', 'text-red-800');

    if (type === 'info') {
        importStatus.classList.add('bg-blue-100', 'text-blue-800');
    } else if (type === 'success') {
        importStatus.classList.add('bg-green-100', 'text-green-800');
    } else if (type === 'error') {
        importStatus.classList.add('bg-red-100', 'text-red-800');
    }
    importMessage.textContent = message;
}

function updateProgress(percent, text) {
    progressBar.style.width = `${percent}%`;
    progressText.textContent = text;
}

// --- GROUP MANAGEMENT ---
function addNewGroup() {
    // Find the highest *numeric* group number
    const maxGroupNum = groupsData
        .filter(g => !g.isFAPool)
        .reduce((max, g) => Math.max(max, g.group), 0);
        
    const newGroup = {
        group: maxGroupNum + 1,
        caregivers: [],
        members: [],
        isFAPool: false
    };
    
    groupsData.push(newGroup);
    saveData();
    renderApp();
}

function deleteGroup(groupIndex) {
    const groupToDelete = groupsData[groupIndex];
    if (!groupToDelete || groupToDelete.isFAPool) return; // Cannot delete FA Pool

    const faPool = groupsData.find(g => g.isFAPool);
    if (faPool) {
        // Move all households to FA Pool
        faPool.members.push(...groupToDelete.caregivers, ...groupToDelete.members);
    }
    
    // Remove the group
    groupsData.splice(groupIndex, 1);
    
    saveData();
    renderApp();
}

// --- UI RENDERING ---
function renderApp() {
    console.log("Rendering app with groupsData:", groupsData);
    groupList.innerHTML = '';
    Object.values(mapMarkers).forEach(marker => marker.remove());
    mapMarkers = {};
    const allBounds = [];

    const searchTerm = searchInput.value.toLowerCase();

    // --- CHANGE: Sort to show FA Pool last, then by group number ---
    const sortedGroups = [...groupsData].sort((a, b) => {
        if (a.isFAPool) return 1;
        if (b.isFAPool) return -1;
        return a.group - b.group;
    });
    // --- END CHANGE ---

    sortedGroups.forEach((group, groupIndex) => { // groupIndex is now the sorted index
        const color = group.isFAPool ? '#6b7280' : groupColors[group.group % groupColors.length];
        const groupElement = createGroupElement(group, groupIndex, color); // Pass sorted index

        const filteredCaregivers = group.caregivers
            .filter(h => passesFilters(h, currentFilters) && passesSearch(h, searchTerm));

        const filteredMembers = group.members
            .filter(h => passesFilters(h, currentFilters) && passesSearch(h, searchTerm));

        [...filteredCaregivers, ...filteredMembers].forEach(household => {
            if (household.coords && household.coords.length === 2) {
                const isCaregiver = filteredCaregivers.some(cg => cg.id === household.id);
                createMapMarker(household, group, color, isCaregiver);
                allBounds.push(household.coords);
            }
        });
        
        if (!group.isFAPool) {
             groupElement.appendChild(createHouseholdContainer('Ministering Brothers', filteredCaregivers, groupIndex, true));
        }
        const memberTitle = group.isFAPool ? 'Unassigned Households' : 'Assigned Households';
        groupElement.appendChild(createHouseholdContainer(memberTitle, filteredMembers, groupIndex, false));

        // --- CHANGE: Logic for hiding empty groups ---
        const isSearchActive = searchTerm.length > 0;
        const isFilterActive = currentFilters.gender !== 'any' || 
                               currentFilters.minAge > 0 || 
                               currentFilters.maxAge < 99 || 
                               currentFilters.hasContact;

        if (filteredCaregivers.length === 0 && filteredMembers.length === 0) {
            // Hide if empty ONLY if a search/filter is active (and it's not the FA Pool)
            if ((isSearchActive || isFilterActive) && !group.isFAPool) {
                groupElement.classList.add('hidden');
            }
            // Otherwise, show the empty group (e.g., after "Add Group" is clicked)
        }
        // --- END CHANGE ---

        groupList.appendChild(groupElement);
    });

    if (allBounds.length > 0) {
        const validBounds = allBounds.filter(b => b && b.length === 2);
        if (validBounds.length > 0) map.fitBounds(validBounds, {
            padding: [50, 50]
        });
    }
}

function createGroupElement(group, groupIndex, color) {
    const el = document.createElement('div');
    el.className = 'group-card p-3 border rounded-lg shadow-sm';
    el.style.borderColor = color;
    el.dataset.groupIndex = groupIndex; // Use array index for dataset
    el.dataset.groupId = group.group; // Use real ID for logic

    const title = group.isFAPool ? 'FA Pool' : `Group ${group.group}`;
    
    const deleteButtonHTML = group.isFAPool ? '' : 
        `<button class="delete-group-btn absolute top-2 right-2 p-1 text-gray-400 hover:text-red-500" title="Delete Group">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
        </button>`;

    el.innerHTML = `
        <div class="relative">
            <h2 class="font-bold text-lg cursor-pointer" style="color: ${color};">${title}</h2>
            ${deleteButtonHTML}
        </div>`;

    el.querySelector('h2').addEventListener('click', () => zoomToGroup(group));
    el.addEventListener('mouseenter', () => handleGroupHover(group, true));
    el.addEventListener('mouseleave', () => handleGroupHover(null, false));
    
    if (!group.isFAPool) {
        el.querySelector('.delete-group-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            // Find the *actual* index in the main groupsData array
            const actualIndex = groupsData.findIndex(g => g.group === group.group);
            if (actualIndex > -1) {
                if (confirm(`Are you sure you want to delete ${title}? All households will be moved to the FA Pool.`)) {
                    deleteGroup(actualIndex);
                }
            }
        });
    }

    return el;
}

function createHouseholdContainer(title, households, groupIndex, isCaregiver) {
    const role = isCaregiver ? 'caregivers' : 'members';
    const container = document.createElement('div');
    container.className = 'mt-2';
    container.innerHTML = `<h3 class="font-semibold text-gray-700 text-sm">${title}:</h3>`;

    const dropZone = document.createElement('div');
    dropZone.className = 'drop-zone';
    dropZone.dataset.role = role;

    const list = document.createElement('ul');
    list.className = 'pl-1 mt-1 space-y-2';
    households.forEach(h => list.appendChild(createHouseholdItem(h, groupIndex, isCaregiver)));

    dropZone.appendChild(list);
    container.appendChild(dropZone);

    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', e => e.currentTarget.classList.remove('drop-zone-active'));
    dropZone.addEventListener('drop', handleDrop);

    return container;
}

function createHouseholdItem(household, groupIndex, isCaregiver) {
    const item = document.createElement('li');
    item.className = 'household-item p-2 bg-gray-50 rounded-md';
    item.draggable = true;
    item.dataset.householdId = household.id;

    // Use the household note generated by the parser
    item.title = household.note;

    // Don't show role change button in FA Pool
    // --- FIX: Use sortedGroups logic consistent with renderApp ---
    const sortedGroups = [...groupsData].sort((a, b) => {
        if (a.isFAPool) return 1;
        if (b.isFAPool) return -1;
        return a.group - b.group;
    });
    // --- END FIX ---
    const currentGroup = sortedGroups[groupIndex];
    
    const roleIcon = household.isCaregiverEligible ? (isCaregiver ? '▼' : '▲') : '🚫';
    const roleTitle = household.isCaregiverEligible ? (isCaregiver ? 'Make Assigned' : 'Make Ministering') : 'Not eligible to be a caregiver';
    
    let roleButtonHTML = '';
    if (currentGroup && !currentGroup.isFAPool) {
        roleButtonHTML = `<button title="${roleTitle}" class="role-change-btn p-1 rounded-full hover:bg-gray-200 ${!household.isCaregiverEligible ? 'cursor-not-allowed opacity-50' : ''}">${roleIcon}</button>`;
    }


    const memberInfoHTML = household.members.map(m => {
        const phoneBtn = m.phone ?
            `<a href="tel:${m.phone}" onclick="event.stopPropagation();" class="call-btn p-1 rounded-full hover:bg-green-200" title="Call ${m.name}">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                   </a>` :
            `<span class="p-1 opacity-20" title="No phone">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                   </span>`;
        const emailBtn = m.email ?
            `<a href="mailto:${m.email}" onclick="event.stopPropagation();" class="email-btn p-1 rounded-full hover:bg-blue-200" title="Email ${m.name}">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                   </a>` :
            `<span class="p-1 opacity-20" title="No email">
                     <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                   </span>`;

        return `
                <div class="flex justify-between items-center text-sm text-gray-800 member-detail-row">
                    <span class="truncate" title="${m.name} (G: ${m.gender || '?'}, A: ${m.age || '?'})">${m.name} (G: ${m.gender || '?'}, A: ${m.age || '?'})</span>
                    <div class="flex space-x-1 flex-shrink-0">${phoneBtn}${emailBtn}</div>
                </div>
            `;
    }).join('');

    item.innerHTML = `
            <div class="flex justify-between items-start w-full">
                <div class="flex-grow truncate">
                    <div class="font-semibold text-sm truncate household-address cursor-pointer" title="Zoom to address: ${household.address}">${household.address}</div>
                </div>
                <div class="flex items-center space-x-1 flex-shrink-0 pl-2">
                    ${roleButtonHTML}
                </div>
            </div>
            <div class="household-details-visible mt-2 pt-2 border-t border-gray-200 space-y-1">
                ${memberInfoHTML}
            </div>
        `;

    item.querySelector('.household-address').addEventListener('click', (e) => {
        e.stopPropagation();
        zoomToHousehold(household);
    });

    item.addEventListener('dragstart', e => handleDragStart(e, household, groupIndex, isCaregiver));

    if (household.isCaregiverEligible && roleButtonHTML) {
        item.querySelector('.role-change-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            handleRoleChange(household, groupIndex, isCaregiver);
        });
    }
    return item;
}

// --- MAP & INTERACTIVITY ---
function createMapMarker(h, group, color, isCaregiver) {
    // --- FIX: Check for valid coords before creating marker
    if (!h.coords || h.coords.length !== 2 || typeof h.coords[0] !== 'number' || typeof h.coords[1] !== 'number') {
        console.warn("Skipping marker for household with invalid coords:", h);
        return; 
    }
    
    const [lat, lng] = h.coords;
    const groupName = group.isFAPool ? 'FA Pool' : `Group ${group.group}`;
    const popupContent = `<b>${h.address}</b><br>${groupName}<br><i>${isCaregiver ? 'Ministering Brothers' : 'Assigned Household'}</i><hr class="my-1">${h.members.map(m => m.name).join('<br>')}`;
    const marker = L.circleMarker([lat, lng], {
        radius: 8,
        color: '#fff',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.9
    }).addTo(map).bindPopup(popupContent);
    marker.householdData = {
        group: group,
        id: h.id
    };
    mapMarkers[h.id] = marker;
}

function zoomToHousehold(household) {
    const marker = mapMarkers[household.id];
    if (marker) {
        map.flyTo(marker.getLatLng(), 16);
        marker.openPopup();
    }
}

function zoomToGroup(group) {
    const bounds = [];
    [...group.caregivers, ...group.members].forEach(h => {
        if (h.coords && h.coords.length === 2) bounds.push(h.coords);
    });
    if (bounds.length > 0) map.flyToBounds(bounds, {
        padding: [50, 50],
        maxZoom: 14
    });
}

function handleGroupHover(hoveredGroup, isHovering) {
    document.querySelectorAll('.group-card').forEach(card => {
        const isHoveredCard = hoveredGroup && card.dataset.groupId == hoveredGroup.group;
        card.classList.toggle('dimmed', isHovering && !isHoveredCard);
    });

    Object.values(mapMarkers).forEach(marker => {
        const icon = marker.getElement();
        if (icon) {
            const partOfHoveredGroup = hoveredGroup && marker.householdData.group.group === hoveredGroup.group;
            icon.classList.toggle('highlight-marker', isHovering && partOfHoveredGroup);
            icon.style.opacity = (isHovering && !partOfHoveredGroup) ? '0.3' : '1';
        }
    });
}

// --- DRAG & DROP AND ROLE CHANGE ---
function handleDragStart(e, household, fromGroupIndex, wasCaregiver) {
    // Find the *actual* group object from the sorted index
    // --- FIX: Use sortedGroups logic consistent with renderApp ---
    const sortedGroups = [...groupsData].sort((a, b) => {
        if (a.isFAPool) return 1;
        if (b.isFAPool) return -1;
        return a.group - b.group;
    });
    // --- END FIX ---
    const fromGroup = sortedGroups[fromGroupIndex];

    draggedItem = {
        household,
        fromGroupId: fromGroup.group, // Store the real group ID
        wasCaregiver
    };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', household.id);
}

function handleDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drop-zone-active');
}

function handleDrop(e) {
    e.preventDefault();
    const dropZone = e.currentTarget;
    dropZone.classList.remove('drop-zone-active');
    if (!draggedItem) return;

    const targetGroupElement = dropZone.closest('.group-card');
    const targetGroupId = targetGroupElement.dataset.groupId === "FA Pool" ? "FA Pool" : parseInt(targetGroupElement.dataset.groupId, 10);
    const targetRole = dropZone.dataset.role;

    // Find groups by their unique 'group' property
    const fromGroup = groupsData.find(g => g.group === draggedItem.fromGroupId);
    const targetGroup = groupsData.find(g => g.group === targetGroupId);

    if (!fromGroup || !targetGroup) {
        console.error('Drag/drop error: could not find group');
        draggedItem = null;
        return;
    }

    // --- Special rule for FA Pool ---
    // If dragging *to* FA Pool, always make it a 'member'
    // If dragging *to* a role that doesn't exist (e.g., 'caregiver' in FA Pool), make it a 'member'
    let effectiveTargetRole = targetRole;
    if (targetGroup.isFAPool || (targetRole === 'caregivers' && !targetGroup.caregivers)) {
        effectiveTargetRole = 'members';
    }


    if (draggedItem.wasCaregiver) {
        fromGroup.caregivers = fromGroup.caregivers.filter(h => h.id !== draggedItem.household.id);
    } else {
        fromGroup.members = fromGroup.members.filter(h => h.id !== draggedItem.household.id);
    }

    if (effectiveTargetRole === 'caregivers') {
        targetGroup.caregivers.push(draggedItem.household);
    } else {
        targetGroup.members.push(draggedItem.household);
    }

    draggedItem = null;
    saveData();
    renderApp();
}

function handleRoleChange(household, groupIndex, isCurrentlyCaregiver) {
    // groupIndex is the sorted array index. Find the real group.
    // --- FIX: Use sortedGroups logic consistent with renderApp ---
    const sortedGroups = [...groupsData].sort((a, b) => {
        if (a.isFAPool) return 1;
        if (b.isFAPool) return -1;
        return a.group - b.group;
    });
    // --- END FIX ---
    const group = sortedGroups[groupIndex];
    
    if (!group || group.isFAPool) {
        console.error("Could not find group for role change or tried to change in FA Pool");
        return;
    }
    if (isCurrentlyCaregiver) {
        group.caregivers = group.caregivers.filter(h => h.id !== household.id);
        group.members.push(household);
    } else {
        group.members = group.members.filter(h => h.id !== household.id);
        group.caregivers.push(household);
    }
    saveData();
    renderApp();
}

// --- Filter Functions ---
/**
 * Checks if a household passes the global filter criteria.
 * A household passes if *any* member passes.
 */
function passesFilters(household, filters) {
    return household.members.some(member => {
        const age = parseInt(member.age, 10) || 0;

        const genderMatch = filters.gender === 'any' || (member.gender && member.gender.toUpperCase() === filters.gender.toUpperCase());
        const minAgeMatch = !filters.minAge || age >= filters.minAge;
        const maxAgeMatch = !filters.maxAge || age <= filters.maxAge;
        const contactMatch = !filters.hasContact || (member.phone && member.email);

        return genderMatch && minAgeMatch && maxAgeMatch && contactMatch;
    });
}

/**
 * Checks if a household passes the search term.
 */
function passesSearch(household, searchTerm) {
    if (!searchTerm) return true;

    const itemText = (household.members.map(m => m.name).join(' ') + ' ' + household.address).toLowerCase();
    return itemText.includes(searchTerm);
}


// --- UTILITIES ---
function handleExport() {
    const dataForSheet = [];
    groupsData.forEach(g => {
        const groupName = g.isFAPool ? 'FA Pool' : g.group;
        g.caregivers.forEach(h => dataForSheet.push({
            'Group': groupName,
            'Role': 'Ministering Brothers',
            'Members': h.members.map(m => m.name).join(', '),
            'Address': h.address,
            'Latitude': h.coords ? h.coords[0] : '',
            'Longitude': h.coords ? h.coords[1] : '',
            'Note': h.note
        }));
        g.members.forEach(h => dataForSheet.push({
            'Group': groupName,
            'Role': g.isFAPool ? 'Unassigned' : 'Assigned Household',
            'Members': h.members.map(m => m.name).join(', '),
            'Address': h.address,
            'Latitude': h.coords ? h.coords[0] : '',
            'Longitude': h.coords ? h.coords[1] : '',
            'Note': h.note
        }));
    });
    const ws = XLSX.utils.json_to_sheet(dataForSheet.sort((a, b) => a.Group - b.Group));

    ws['!cols'] = [{
        wch: 8
    }, // Group
    {
        wch: 20
    }, // Role
    {
        wch: 40
    }, // Members
    {
        wch: 50
    }, // Address
    {
        wch: 12
    }, // Latitude
    {
        wch: 12
    }, // Longitude
    {
        wch: 30
    } // Note
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ministering Groups");
    XLSX.writeFile(wb, `Ministering_Groups_${new Date().toISOString().split('T')[0]}.xlsx`);
}

// --- Helper functions for K-means clustering ---

/**
 * Calculates the Haversine distance between two [lat, lon] points in km.
 */
function getDistance(coords1, coords2) {
    if (!coords1 || !coords2) return Infinity;
    
    // --- FIX: Ensure coords are valid numbers ---
    const lat1 = parseFloat(coords1[0]);
    const lon1 = parseFloat(coords1[1]);
    const lat2 = parseFloat(coords2[0]);
    const lon2 = parseFloat(coords2[1]);

    if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) {
        return Infinity;
    }

    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c;
    return d;
}

/**
 * Selects K random initial centroids from the household list.
 */
function getRandomCentroids(households, k) {
    const centroids = [];
    const shuffled = [...households].sort(() => 0.5 - Math.random());
    for (let i = 0; i < k; i++) {
        if (shuffled[i] && shuffled[i].coords) { // Check for coords
            centroids.push(shuffled[i].coords);
        }
    }
    // Ensure we return K centroids, even if some are duplicates
    while (centroids.length < k && households.length > 0) {
        const randomHousehold = households[Math.floor(Math.random() * households.length)];
        if (randomHousehold && randomHousehold.coords) {
            centroids.push(randomHousehold.coords);
        }
    }
    return centroids;
}
