document.addEventListener('DOMContentLoaded', function() {
    // --- DOM ELEMENT REFERENCES ---
    const loginOverlay = document.getElementById('login-overlay');
    const appContainer = document.getElementById('app');
    const loginForm = document.getElementById('login-form');
    const passwordInput = document.getElementById('password');
    const loginError = document.getElementById('login-error');
    const searchInput = document.getElementById('search-input');
    const groupList = document.getElementById('group-list');
    const exportButton = document.getElementById('export-button');
    const loader = document.getElementById('loader');
    
    // --- GLOBAL STATE ---
    let groupsData = [];
    let draggedItem = null;
    let mapMarkers = {}; // Use an object for easier marker lookup by ID
    const map = L.map('map');
    const groupColors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#42d4f4', '#d2f53c', '#f032e6', '#fabebe', '#0082c8', '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075'];

    // --- DATA PERSISTENCE ---
    function loadData() {
        const savedData = localStorage.getItem('groupsData');
        let data = savedData ? JSON.parse(savedData) : initialGroupsData;
        data.forEach(group => {
            [...group.caregivers, ...group.members].forEach(household => {
                if (!household.id) {
                    household.id = crypto.randomUUID();
                }
            });
        });
        groupsData = data;
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
        map.setView([43.85, -79.4], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
            maxZoom: 19, 
            attribution: '© OpenStreetMap contributors' 
        }).addTo(map);

        exportButton.addEventListener('click', handleExport);
        searchInput.addEventListener('input', handleSearch);
        
        renderApp();
        loader.style.display = 'none';
    }

    // --- UI RENDERING ---
    function renderApp() {
        groupList.innerHTML = '';
        Object.values(mapMarkers).forEach(marker => marker.remove());
        mapMarkers = {};
        const allBounds = [];

        groupsData.forEach((group, groupIndex) => {
            const color = groupColors[groupIndex % groupColors.length];
            const groupElement = createGroupElement(group, groupIndex, color);

            [...group.caregivers, ...group.members].forEach(household => {
                if (household.coords && household.coords.length === 2) {
                    const isCaregiver = group.caregivers.some(cg => cg.id === household.id);
                    createMapMarker(household, group, color, isCaregiver);
                    allBounds.push(household.coords);
                }
            });
            groupList.appendChild(groupElement);
        });

        if (allBounds.length > 0) {
            const validBounds = allBounds.filter(b => b && b.length === 2);
            if (validBounds.length > 0) map.fitBounds(validBounds, { padding: [50, 50] });
        }
    }

    function createGroupElement(group, groupIndex, color) {
        const el = document.createElement('div');
        el.className = 'group-card p-3 border rounded-lg shadow-sm';
        el.style.borderColor = color;
        el.dataset.groupId = group.group;
        el.innerHTML = `<h2 class="font-bold text-lg cursor-pointer" style="color: ${color};">Group ${group.group}</h2>`;
        
        el.querySelector('h2').addEventListener('click', () => zoomToGroup(group));
        el.addEventListener('mouseenter', () => handleGroupHover(group, true));
        el.addEventListener('mouseleave', () => handleGroupHover(null, false));

        el.appendChild(createHouseholdContainer('Ministering Brothers', group.caregivers, groupIndex, true));
        el.appendChild(createHouseholdContainer('Assigned Households', group.members, groupIndex, false));
        
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
        item.className = 'household-item p-2 bg-gray-50 rounded-md flex justify-between items-center';
        item.draggable = true;
        item.dataset.householdId = household.id;
        if (household.note) {
            item.title = household.note;
        }

        const roleIcon = household.isCaregiverEligible ? (isCaregiver ? '▼' : '▲') : '🚫';
        const roleTitle = household.isCaregiverEligible ? (isCaregiver ? 'Make Assigned' : 'Make Ministering') : 'Not eligible to be a caregiver';

        item.innerHTML = `
            <div class="text-sm text-gray-800 flex-grow">
                ${household.members.join(', ')}
                <span class="block text-xs text-gray-500">${household.address}</span>
            </div>
            <div class="flex items-center space-x-1 flex-shrink-0">
                <button title="${roleTitle}" class="role-change-btn p-1 rounded-full hover:bg-gray-200 ${!household.isCaregiverEligible ? 'cursor-not-allowed opacity-50' : ''}">${roleIcon}</button>
            </div>
        `;
        
        item.addEventListener('click', () => zoomToHousehold(household));
        item.addEventListener('dragstart', e => handleDragStart(e, household, groupIndex, isCaregiver));
        if (household.isCaregiverEligible) {
            item.querySelector('.role-change-btn').addEventListener('click', (e) => { e.stopPropagation(); handleRoleChange(household, groupIndex, isCaregiver); });
        }
        return item;
    }

    // --- MAP & INTERACTIVITY ---
    function createMapMarker(h, group, color, isCaregiver) {
         const [lat, lng] = h.coords;
         const popupContent = `<b>${h.address}</b><br>Group ${group.group}<br><i>${isCaregiver ? 'Ministering Brothers' : 'Assigned Household'}</i><hr class="my-1">${h.members.join('<br>')}`;
         const marker = L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.9 }).addTo(map).bindPopup(popupContent);
         marker.householdData = { group: group, id: h.id };
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
        [...group.caregivers, ...group.members].forEach(h => { if(h.coords && h.coords.length === 2) bounds.push(h.coords); });
        if (bounds.length > 0) map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 14 });
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
        draggedItem = { household, fromGroupIndex, wasCaregiver };
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
        const targetGroupId = parseInt(targetGroupElement.dataset.groupId, 10);
        const targetRole = dropZone.dataset.role;

        const fromGroup = groupsData[draggedItem.fromGroupIndex];
        const targetGroup = groupsData.find(g => g.group === targetGroupId);

        if (draggedItem.wasCaregiver) {
            fromGroup.caregivers = fromGroup.caregivers.filter(h => h.id !== draggedItem.household.id);
        } else {
            fromGroup.members = fromGroup.members.filter(h => h.id !== draggedItem.household.id);
        }
        
        if (targetRole === 'caregivers') {
            targetGroup.caregivers.push(draggedItem.household);
        } else {
            targetGroup.members.push(draggedItem.household);
        }

        draggedItem = null;
        saveData();
        renderApp();
    }

    function handleRoleChange(household, groupIndex, isCurrentlyCaregiver) {
        const group = groupsData[groupIndex];
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
    
    // --- UTILITIES ---
    function handleSearch(e) {
        const searchTerm = e.target.value.toLowerCase();
        document.querySelectorAll('.group-card').forEach(card => {
            let groupHasVisibleMembers = false;
            card.querySelectorAll('.household-item').forEach(item => {
                const itemText = item.textContent.toLowerCase();
                const isMatch = itemText.includes(searchTerm);
                item.classList.toggle('hidden', !isMatch);
                if (isMatch) groupHasVisibleMembers = true;
            });
            card.classList.toggle('hidden', !groupHasVisibleMembers);
        });
    }

    function handleExport() {
        const dataForSheet = [];
        groupsData.forEach(g => {
            g.caregivers.forEach(h => dataForSheet.push({ 'Group': g.group, 'Role': 'Ministering Brothers', 'Address': h.address, 'Members': h.members.join(', '), 'Note': h.note }));
            g.members.forEach(h => dataForSheet.push({ 'Group': g.group, 'Role': 'Assigned Household', 'Address': h.address, 'Members': h.members.join(', '), 'Note': h.note }));
        });
        const ws = XLSX.utils.json_to_sheet(dataForSheet.sort((a, b) => a.Group - b.Group));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Groups");
        XLSX.writeFile(wb, "Member_Groups.xlsx");
    }
});

