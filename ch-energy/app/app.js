///////////////////////////////////////////////////////////////////////////////
// Constants
///////////////////////////////////////////////////////////////////////////////

// Color palette for different categories
const FACILITIES_CATEGORY_COLORS = {
    'Photovoltaic': [255, 193, 7],         // Amber/Yellow - solar
    'Hydroelectric power': [33, 150, 243], // Blue - water
    'Wind energy': [76, 175, 80],          // Green - wind
    'Biomass': [139, 69, 19],              // Brown - organic
    'Natural gas': [255, 87, 34],          // Orange-red - gas
    'Waste': [100, 100, 100],              // Gray - waste
    'Nuclear energy': [156, 39, 176],      // Purple - nuclear
    'Crude oil': [96, 125, 139]            // Blue-gray - oil
};

// Color palette for production categories
// (same colors as facilities categories for matching categories)
const PRODUCTION_CATEGORY_COLORS = {
    'Hydro (pumped)': [33, 150, 243],      // Blue
    'Hydro (river)': [21, 101, 192],       // Darker blue
    'Nuclear': [156, 39, 176],             // Purple
    'Photovoltaic': [255, 193, 7],         // Amber/Yellow
    'Thermal': [255, 87, 34],              // Orange-red
    'Wind': [76, 175, 80]                  // Green
};

// Time unit names for production chart title
const TIME_UNIT_NAMES = {
    'day': 'Daily',
    'week': 'Weekly',
    'month': 'Monthly',
    'quarter': 'Quarterly'
};

// Production categories (from production.json.gz)
const PRODUCTION_CATEGORIES = [
    'Hydro (pumped)',
    'Hydro (river)',
    'Nuclear',
    'Photovoltaic',
    'Thermal',
    'Wind'
];

const TABLE_COLUMNS = ["SubCategory", "TotalPower", "Municipality", "Canton", "BeginningOfOperation", "gps"];
const TABLE_NUM_ROWS = 50;       // Show 50 facilities per page
const DEBOUNCE_MS = 100;         // 300ms delay to debounce expensive UI interactions.

///////////////////////////////////////////////////////////////////////////////
// Global state
///////////////////////////////////////////////////////////////////////////////

let MAPTILER_KEY = null;         // Load from file.
let deckgl = null;               // DeckGL instance.
const { Deck, ScatterplotLayer } = deck;

let lastUpdate = null;           // Last data update date string.
let isInitializing = true;       // Flag to prevent nouiSlider callbacks from being called during initialization

let facilities = {
    all: [],                     // All power facilities.
    filtered: [],                // Facilities that match the current selection (category, power range)
    onTable: [],                 // Currently displayed facilities in table
    categories: [],              // All categories (solar, hydro, etc.)
    categoryStats: {}            // Category statistics
}

// Production data state
let productionData = [];         // Historical production data
let productionChart = null;      // Chart.js instance

// Global state object
const appState = {
    // Top-level toggle, facilities vs production mode
    isProductionMode: false,

    // Facilities mode state
    isTableView: false,
    currentSort: { column: 'TotalPower', sortAscending: false },
    currentPage: 1,
    minPower: 0.1,
    maxPower: 2000000,
    searchTokens: [],
    selectedFacilitiesCategories: null,

    // Production mode state
    selectedProductionCategories: null,

    // Map view state
    mapView: {
        latitude: 46.8182,
        longitude: 8.2275,
        zoom: 8
    },

    // Production chart state
    productionChart: {
        xmin: null,
        xmax: null
    }
};

///////////////////////////////////////////////////////////////////////////////
// State serialization/deserialization functions
///////////////////////////////////////////////////////////////////////////////

let serializeTimeout = null;
function serializeStateToURL() {
    // Serialize the full appState to JSON and encode as base64
    if (serializeTimeout) {
        clearTimeout(serializeTimeout);
    }

    serializeTimeout = setTimeout(() => {
        const encodedState = btoa(JSON.stringify(appState));

        // Update URL without triggering a page reload
        const newURL = `${window.location.pathname}?s=${encodedState}`;
        window.history.replaceState({}, '', newURL);
        console.log('encoded state', appState);
    }, DEBOUNCE_MS);
}

function deserializeStateFromURL() {
    function decodeInt(value, setter, min = null) {
        if (value !== undefined && value !== null) {
            const num = parseInt(value);
            if (!isNaN(num) && (min === null || num >= min)) {
                setter(num);
            }
        }
    }

    function decodeFloat(value, setter, min = null, max = null) {
        if (value !== undefined && value !== null) {
            const num = parseFloat(value);
            if (!isNaN(num) && (min === null || num >= min) && (max === null || num <= max)) {
                setter(num);
            }
        }
    }

    const params = new URLSearchParams(window.location.search);
    const encodedState = params.get('s');

    if (!encodedState) return;

    try {
        const state = JSON.parse(atob(encodedState));
        if (!state || typeof state !== 'object') {
            console.warn('Invalid state');
            return;
        }
        if (state.isProductionMode !== undefined) {
            appState.isProductionMode = state.isProductionMode;
        }
        if (state.isTableView !== undefined) {
            appState.isTableView = state.isTableView;
        }
        if (state.currentSort && typeof state.currentSort === 'object') {
            if (state.currentSort.column && TABLE_COLUMNS.includes(state.currentSort.column)) {
                appState.currentSort.column = state.currentSort.column;
                appState.currentSort.sortAscending = state.currentSort.sortAscending;
            }
        }
        decodeInt(state.currentPage, (val) => appState.currentPage = val);
        if (Array.isArray(state.selectedFacilitiesCategories)) {
            appState.selectedFacilitiesCategories = state.selectedFacilitiesCategories
                .filter(c => typeof c === 'string' && facilities.categories.includes(c));
        }
        decodeFloat(state.minPower, (val) => appState.minPower = val, 0);
        decodeFloat(state.maxPower, (val) => appState.maxPower = val, 0);
        if (Array.isArray(state.searchTokens)) {
            appState.searchTokens = state.searchTokens.filter(t => typeof t === 'string');
        }
        if (Array.isArray(state.selectedProductionCategories)) {
            appState.selectedProductionCategories = state.selectedProductionCategories
                .filter(c => typeof c === 'string' && PRODUCTION_CATEGORIES.includes(c));
        }
        if (state.mapView && typeof state.mapView === 'object') {
            decodeFloat(state.mapView.latitude, (val) => appState.mapView.latitude = val, -90, 90);
            decodeFloat(state.mapView.longitude, (val) => appState.mapView.longitude = val, -180, 180);
            decodeFloat(state.mapView.zoom, (val) => appState.mapView.zoom = val, 0);
        }
        if (state.productionChart && typeof state.productionChart === 'object') {
            decodeFloat(state.productionChart.xmin, (val) => appState.productionChart.xmin = val);
            decodeFloat(state.productionChart.xmax, (val) => appState.productionChart.xmax = val);
        }
    } catch (error) {
        console.warn('Failed to deserialize state from URL:', error);
    }
    console.log('decoded state', appState);
}

///////////////////////////////////////////////////////////////////////////////
// Entry point
///////////////////////////////////////////////////////////////////////////////

async function initialize() {
    async function loadMapTilerKey() {
        const response = await fetch('maptiler-key.txt');
        if (!response.ok) {
            throw new Error(`Failed to load MapTiler key: ${response.status} ${response.statusText}`);
        }
        const key = await response.text();
        return key.trim();
    }

    try {
        MAPTILER_KEY = await loadMapTilerKey();
    } catch (error) {
        console.error('Failed to load MapTiler key:', error);
        const loadingOverlay = document.getElementById('loadingOverlay');
        loadingOverlay.innerHTML = `
            <div class="loading-content">
                <h3>⚠️ MapTiler API Key Missing</h3>
                <p><strong>Cannot load map tiles.</strong></p>
                <p style="font-size: 12px; color: #666; margin-top: 15px;">Contact maxp@maxp.net for help.</p>
            </div>
        `;
        isInitializing = false;
        return;
    }

    await loadData();
    initializeDeckGL();
    initializeUI();
    isInitializing = false;
}

function initializeDeckGL() {
    maptilersdk.config.apiKey = MAPTILER_KEY;
    deckgl = new deck.DeckGL({
        container: 'map',
        map: maptilersdk,
        mapStyle: maptilersdk.MapStyle.BASIC,
        initialViewState: {
            longitude: appState.mapView.longitude,
            latitude: appState.mapView.latitude,
            zoom: appState.mapView.zoom,
            pitch: 0,
            bearing: 0
        },
        controller: true,
        layers: [],
        onViewStateChange: ({ viewState }) => {
            // Update map view state when map is moved
            appState.mapView.latitude = viewState.latitude;
            appState.mapView.longitude = viewState.longitude;
            appState.mapView.zoom = viewState.zoom;
            serializeStateToURL();
        },
        widgets: [
            new deck.FullscreenWidget({
                id: 'fullscreen-control',
                style: {
                    // Style to center-align with help button.
                    position: 'fixed',
                    top: '70px',
                    left: '19px',
                    padding: '0px',
                    margin: '0px',
                    zIndex: 1000
                }
            }),
            new deck.ZoomWidget({
                id: 'zoom-control',
                orientation: 'vertical',
                style: {
                    // Style to center-align with help button.
                    position: 'fixed',
                    top: '110px',
                    left: '19px',
                    padding: '0px',
                    margin: '0px',
                    zIndex: 1000
                }
            })
        ],
        getTooltip: ({ object }) => {
            if (!object) return null;
            return {
                html: `
                    <strong>${object.SubCategory}</strong><br/>
                    Power: ${object.TotalPower.toLocaleString()} kW<br/>
                    Location: ${object.Municipality}, ${object.Canton}<br/>
                    Started: ${object.BeginningOfOperation}
                `,
                style: {
                    backgroundColor: 'white',
                    fontSize: '12px',
                    padding: '8px',
                    borderRadius: '4px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
                }
            };
        }
    });
}

async function loadData() {
    try {
        // Add daily timestamp to limit caching time to one day.
        const t = new Date();
        const ts = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();

        // Download facilities data.
        const facilitiesResponse = await fetch(`data/facilities.json?v=${ts}`);
        if (!facilitiesResponse.ok) {
            throw new Error(`Failed to load facilities data: ${facilitiesResponse.status} ${facilitiesResponse.statusText}`);
        }
        facilities.all = await facilitiesResponse.json();
        const numFacilitiesWithCoords = facilities.all.filter(f => f.lat && f.lon).length;
        facilities.categories = [...new Set(facilities.all.map(f => f.SubCategory))].sort();

        // Download production data.
        const productionResponse = await fetch(`data/production.json?v=${ts}`);
        if (!productionResponse.ok) {
            throw new Error(`Failed to load production data: ${productionResponse.status} ${productionResponse.statusText}`);
        }
        productionData = await productionResponse.json();
        productionData.map(d => {
            const [year, month, day] = d.date.split('-').map(Number);
            d.date = new Date(year, month - 1, day); // Parse as local time.
        });

        // Download last update time.
        const updateResponse = await fetch(`data/last-update.txt?v=${ts}`);
        if (updateResponse.ok) {
            lastUpdate = await updateResponse.text();
            if (! (lastUpdate && /^\d{4}-\d{2}-\d{2}$/.test(lastUpdate.trim()))) {
                lastUpdate = null;
            }
        }

        // Import state (if any) from URL.
        deserializeStateFromURL();

        if (appState.selectedProductionCategories === null) {
            // Initialize with all production categories on first load (=== null)
            appState.selectedProductionCategories = [...PRODUCTION_CATEGORIES];
        }
        if (appState.selectedFacilitiesCategories === null) {
            // Initialize with all facilities categories on first load (=== null)
            appState.selectedFacilitiesCategories = [...facilities.categories];
        }

        // Hide loading overlay after successful data load
        document.getElementById('loadingOverlay').style.display = 'none';

        console.log(`Loaded ${facilities.all.length} facilities, ${numFacilitiesWithCoords} with coordinates`);
        console.log(`Loaded ${productionData.length} days of production data`);
    } catch (error) {
        console.error('Error loading data:', error);

        // Show error overlay and halt app initialization
        const loadingOverlay = document.getElementById('loadingOverlay');
        loadingOverlay.innerHTML = `
            <div class="loading-content">
                <h3>⚠️ Error Loading Data</h3>
                <p><strong>Failed to load energy data.</strong></p>
                <p style="font-size: 12px; color: #666; margin-top: 15px;">
                    ${error.message}
                </p>
                <p style="margin-top: 20px;">
                    <button id="retryButton" onclick="window.location.reload()">Retry</button>
                </p>
            </div>
        `;
        loadingOverlay.style.display = 'flex';
        return;
    }
}

function initializeUI() {
    function _renderPowerSlider() {
        const powerRangeSlider = document.getElementById('powerRangeSlider');
        noUiSlider.create(powerRangeSlider, {
            start: [
                Math.log10(appState.minPower) + 1,
                Math.log10(appState.maxPower) + 1],
            connect: true,
            range: {
                'min': Math.log10(0.1) + 1,
                'max': Math.log10(2000000) + 1
            },
            step: 0.1
        });
    }

    function _renderFacilitiesCategories() {
        const container = document.getElementById('categoryTableBody');
        container.innerHTML = '';

        // Select/Deselect all checkbox
        const allCheckbox = document.createElement('input');
        allCheckbox.type = 'checkbox';
        allCheckbox.className = 'category-checkbox';
        allCheckbox.id = 'cat-select-all';
        allCheckbox.checked = appState.selectedFacilitiesCategories.length === facilities.categories.length;
        const allLabel = document.createElement('label');
        allLabel.htmlFor = 'cat-select-all';
        allLabel.textContent = 'Select/Deselect All';
        const allTd = document.createElement('td');
        allTd.colSpan = 3;
        allTd.appendChild(allCheckbox);
        allTd.appendChild(allLabel);
        let tr = document.createElement('tr');
        tr.appendChild(allTd);
        container.appendChild(tr);

        facilities.categories.forEach(category => {
            tr = document.createElement('tr');

            // Source column with checkbox and color indicator
            const sourceCell = document.createElement('td');
            sourceCell.className = 'source-cell';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'category-checkbox';
            checkbox.id = `cat-${category.replace(/\s+/g, '-')}`;
            checkbox.value = category;
            checkbox.checked = appState.selectedFacilitiesCategories.includes(category);

            const label = document.createElement('label');
            label.className = 'category-label';
            label.htmlFor = checkbox.id;

            const colorIndicator = document.createElement('span');
            colorIndicator.className = 'color-indicator';
            const color = FACILITIES_CATEGORY_COLORS[category] || [128, 128, 128];
            colorIndicator.style.backgroundColor = `rgb(${color.join(',')})`;

            const text = document.createElement('span');
            text.textContent = category;

            label.appendChild(colorIndicator);
            label.appendChild(text);
            sourceCell.appendChild(checkbox);
            sourceCell.appendChild(label);

            // Count column
            const countCell = document.createElement('td');
            countCell.className = 'count-cell';
            countCell.id = `count-${category.replace(/\s+/g, '-')}`;

            // Capacity column (in MW)
            const capacityCell = document.createElement('td');
            capacityCell.className = 'capacity-cell';
            capacityCell.id = `capacity-${category.replace(/\s+/g, '-')}`;

            tr.appendChild(sourceCell);
            tr.appendChild(countCell);
            tr.appendChild(capacityCell);
            container.appendChild(tr);
        });
    }

    function _renderProductionCategories() {
        const container = document.getElementById('productionCategoryTableBody');
        container.innerHTML = '';

        // Select/Deselect all checkbox
        const allCheckbox = document.createElement('input');
        allCheckbox.type = 'checkbox';
        allCheckbox.className = 'category-checkbox';
        allCheckbox.id = 'prod-cat-select-all';
        allCheckbox.checked = appState.selectedProductionCategories.length === PRODUCTION_CATEGORIES.length;
        const allLabel = document.createElement('label');
        allLabel.htmlFor = 'prod-cat-select-all';
        allLabel.textContent = 'Select/Deselect All';
        const allTd = document.createElement('td');
        allTd.colSpan = 2;
        allTd.appendChild(allCheckbox);
        allTd.appendChild(allLabel);
        let tr = document.createElement('tr');
        tr.appendChild(allTd);
        container.appendChild(tr);

        PRODUCTION_CATEGORIES.forEach((category, index) => {
            tr = document.createElement('tr');

            // Source column with checkbox and color indicator
            const sourceCell = document.createElement('td');
            sourceCell.className = 'source-cell';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'category-checkbox';
            checkbox.id = `prod-cat-${index}`;
            checkbox.value = category;
            checkbox.checked = appState.selectedProductionCategories.includes(category);

            const label = document.createElement('label');
            label.className = 'category-label';
            label.htmlFor = checkbox.id;

            const colorIndicator = document.createElement('span');
            colorIndicator.className = 'color-indicator';
            const color = PRODUCTION_CATEGORY_COLORS[category] || [128, 128, 128];
            colorIndicator.style.backgroundColor = `rgb(${color.join(',')})`;

            const text = document.createElement('span');
            text.textContent = category;

            label.appendChild(colorIndicator);
            label.appendChild(text);
            sourceCell.appendChild(checkbox);
            sourceCell.appendChild(label);

            // Average daily production column
            const avgCell = document.createElement('td');
            avgCell.className = 'count-cell';
            avgCell.id = `prod-avg-${index}`;

            tr.appendChild(sourceCell);
            tr.appendChild(avgCell);
            container.appendChild(tr);
        });
        updateProductionStats(0, Infinity);
    }

    _renderPowerSlider();
    _renderFacilitiesCategories();
    _renderProductionCategories();
    sortFacilities(appState.currentSort.column, appState.currentSort.sortAscending);
    setupEventHandlers();

    if (appState.isProductionMode) {
        modeProduction();
    } else {
        modeFacilities();
    }
}

///////////////////////////////////////////////////////////////////////////////
// Event handlers
///////////////////////////////////////////////////////////////////////////////

function callbackModeFacilities() {
    if (!appState.isProductionMode) { return; }
    appState.isProductionMode = false;
    modeFacilities();
    serializeStateToURL();
}

function callbackModeProduction() {
    if (appState.isProductionMode) { return; }
    appState.isProductionMode = true;
    modeProduction();
    serializeStateToURL();
}

function callbackFacilityViewToggle() {
    if (appState.isProductionMode) {
        throw new Error('callbackFacilityViewToggle called in production mode');
    }

    appState.isTableView = !appState.isTableView;
    const mapContainer = document.getElementById('map');
    const tableContainer = document.getElementById('tableView');
    const toggleButton = document.getElementById('viewToggle');

    if (appState.isTableView) {
        mapContainer.style.display = 'none';
        tableContainer.style.display = 'block';
        toggleButton.textContent = '🗺️ Map View';
    } else {
        mapContainer.style.display = 'block';
        tableContainer.style.display = 'none';
        toggleButton.textContent = '📊 Table View';
    }
    renderTableOrMap();
}

function callbackProductionResetZoom() {
    if (!productionChart) return;
    productionChart.resetZoom();
}

function setupEventHandlers() {

    function setupProductionCategorySelectorHandlers() {
        const allCheckbox = document.getElementById('prod-cat-select-all');
        document.getElementById('productionCategoryTableBody').addEventListener('change', function (e) {
            if (e.target.type === 'checkbox') {
                if (e.target.id === 'prod-cat-select-all') {
                    // Select/deselect all
                    const checked = e.target.checked;
                    document.querySelectorAll('#productionCategoryTableBody input[type="checkbox"]').forEach(cb => {
                        if (cb.id !== 'prod-cat-select-all') cb.checked = checked;
                    });
                    appState.selectedProductionCategories = checked ? [...PRODUCTION_CATEGORIES] : [];
                } else {
                    appState.selectedProductionCategories = Array
                        .from(document.querySelectorAll('#productionCategoryTableBody input[type="checkbox"]:not(#prod-cat-select-all):checked'))
                        .map(cb => cb.value);
                    // Sync select-all checkbox
                    const allChecked = appState.selectedProductionCategories.length === PRODUCTION_CATEGORIES.length;
                    allCheckbox.checked = allChecked;
                }
                updateProductionChart();
                serializeStateToURL();
            }
        });
    }

    function setupInfoModalHandlers() {
        const infoButton = document.getElementById('infoButton');
        const infoModal = document.getElementById('infoModal');
        const closeModal = document.getElementById('closeModal');

        infoButton.addEventListener('click', () => {
            infoModal.classList.add('show');
        });

        closeModal.addEventListener('click', () => {
            infoModal.classList.remove('show');
        });

        // Close modal when clicking outside
        infoModal.addEventListener('click', (e) => {
            if (e.target === infoModal) {
                infoModal.classList.remove('show');
            }
        });

        // Close modal with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && infoModal.classList.contains('show')) {
                infoModal.classList.remove('show');
            }
        });
    }

    setupTableEventHandlers();
    document.getElementById('categoryTableBody').addEventListener('change', callbackFacilitiesCategories);
    setupProductionCategorySelectorHandlers();
    setupInfoModalHandlers();

    const facilitiesBtn = document.getElementById('facilitiesMode');
    facilitiesBtn.addEventListener('click', callbackModeFacilities);

    const productionBtn = document.getElementById('productionMode');
    productionBtn.addEventListener('click', callbackModeProduction);

    const viewToggle = document.getElementById('viewToggle');
    viewToggle.addEventListener('click', callbackFacilityViewToggle);

    const powerRangeSlider = document.getElementById('powerRangeSlider');
    powerRangeSlider.noUiSlider.on('update', callbackPowerSlider);

    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', callbackSearchInput);

    const resetZoomBtn = document.getElementById('resetZoom');
    resetZoomBtn.addEventListener('click', callbackProductionResetZoom);

}

///////////////////////////////////////////////////////////////////////////////
// Table view
///////////////////////////////////////////////////////////////////////////////

function callbackPageNumber(e) {
    const totalPages = Math.ceil(facilities.onTable.length / TABLE_NUM_ROWS);

    function createPageNumberSpan() {
        const span = document.createElement('span');
        span.id = 'currentPageNumber';
        span.textContent = appState.currentPage.toString();
        span.addEventListener('click', callbackPageNumber);
        return span;
    }
    function createPageNumberInput() {
        const input = document.createElement('input');
        input.id = 'pageNumberInput';
        input.type = 'number';
        input.min = '1';
        input.max = totalPages.toString();
        input.value = appState.currentPage.toString();
        return input;
    }
    function inputBlur() {
        const pageNumber = parseInt(input.value);
        if (pageNumber >= 1 && pageNumber <= totalPages) {
            appState.currentPage = pageNumber;
        }
        // Restore span with current page number
        const newSpan = createPageNumberSpan();
        input.parentNode.replaceChild(newSpan, input);
        if (pageNumber >= 1 && pageNumber <= totalPages) {
            renderTable();
        }
    }
    function inputKeyDown(e) {
        if (e.key === 'Enter') {
            inputBlur();
        } else if (e.key === 'Escape') {
            // Cancel edit - restore span without changing page
            const newSpan = createPageNumberSpan();
            input.parentNode.replaceChild(newSpan, input);
        }
    }

    // Replace span with input
    const input = createPageNumberInput();
    e.target.parentNode.replaceChild(input, e.target);
    input.focus();
    input.select();
    input.addEventListener('blur', inputBlur);
    input.addEventListener('keydown', inputKeyDown);
}

function setupTableEventHandlers() {
    const tableHeaders = document.querySelectorAll('#facilitiesTable th.sortable');
    tableHeaders.forEach(header => {
        header.addEventListener('click', () => {
            const column = header.dataset.sort;
            sortTable(column);
        });
    });
    document.getElementById('firstPage').addEventListener('click', () => {
        if (appState.currentPage > 1) {
            appState.currentPage = 1;
            renderTable();
        }
    });
    document.getElementById('prevPage').addEventListener('click', () => {
        if (appState.currentPage > 1) {
            appState.currentPage--;
            renderTable();
        }
    });
    document.getElementById('nextPage').addEventListener('click', () => {
        const totalPages = Math.ceil(facilities.onTable.length / TABLE_NUM_ROWS);
        if (appState.currentPage < totalPages) {
            appState.currentPage++;
            renderTable();
        }
    });
    document.getElementById('lastPage').addEventListener('click', () => {
        const totalPages = Math.ceil(facilities.onTable.length / TABLE_NUM_ROWS);
        if (appState.currentPage < totalPages) {
            appState.currentPage = totalPages;
            renderTable();
        }
    });

    // Page number click => inline input
    document.getElementById('currentPageNumber').addEventListener('click', callbackPageNumber);
}

function sortFacilities(column, sortAscending) {
    switch (column) {
        case 'TotalPower':
            facilities.all.sort((a, b) =>
                {
                    v = (a.TotalPower || 0) - (b.TotalPower || 0); return sortAscending ? v : -v;
                });
            break;
        case 'BeginningOfOperation':
            facilities.all.sort((a, b) =>
                {
                    v = new Date(a.BeginningOfOperation || '1800-01-01') - new Date(b.BeginningOfOperation || '1800-01-01');
                    return sortAscending ? v : -v;
                });
            break;
        case 'gps':
            facilities.all.sort((a, b) => {
                v = (a.lat && a.lon) - (b.lat && b.lon);
                return sortAscending ? v : -v;
            });
            break;
        default:
            facilities.all.sort((a, b) => {
                v = (a[column] || '').toString().toLowerCase().localeCompare((b[column] || '').toString().toLowerCase());
                return sortAscending ? v : -v;
            });
            break;
    }
}

function sortTable(column) {
    if (appState.currentSort.column === column) {
        appState.currentSort.sortAscending = !appState.currentSort.sortAscending;
    } else {
        appState.currentSort.column = column;
        appState.currentSort.sortAscending = true;
    }
    console.log('sortTable', column, appState.currentSort.sortAscending);

    // Sort the underlying facilities array
    sortFacilities(column, appState.currentSort.sortAscending);
    console.log('sortTable', facilities.all[0]);
    filterFacilities();
    renderTable(true);
}

function renderTable(reset = false) {
    if (!appState.isTableView) {
        throw new Error('updateTable called in map view');
    }
    if (reset) {
        // Use the same filtered facilities as the map (already sorted in underlying array)
        facilities.onTable = [...facilities.filtered];
        // Reset to first page when data changes
        appState.currentPage = 1;
    }
    const p = appState.currentPage;

    // Render table header.

    // Clear all sort indicators and set the new one
    const thead = document.getElementById('facilitiesTableHead');
    thead.querySelectorAll('.sort-indicator').forEach(indicator => { indicator.className = 'sort-indicator'; });
    const currentHeader = thead.querySelector(`th[data-sort="${appState.currentSort.column}"] .sort-indicator`);
    currentHeader.className = `sort-indicator ${appState.currentSort.sortAscending ? 'asc' : 'desc'}`;

    // Render table body.

    const tbody = document.getElementById('facilitiesTableBody');
    tbody.innerHTML = '';

    // Calculate pagination
    const startIndex = (p - 1) * TABLE_NUM_ROWS;
    const endIndex = Math.min(startIndex + TABLE_NUM_ROWS, facilities.onTable.length);
    const facilitiesToShow = facilities.onTable.slice(startIndex, endIndex);

    facilitiesToShow.forEach(facility => {
        const row = document.createElement('tr');

        // Energy Source with color indicator
        const sourceCell = document.createElement('td');
        sourceCell.className = 'energy-source-cell';
        const colorIndicator = document.createElement('span');
        colorIndicator.className = 'table-color-indicator';
        const color = FACILITIES_CATEGORY_COLORS[facility.SubCategory] || [128, 128, 128];
        colorIndicator.style.backgroundColor = `rgb(${color.join(',')})`;
        sourceCell.appendChild(colorIndicator);
        sourceCell.appendChild(document.createTextNode(facility.SubCategory || ''));

        // Power
        const powerCell = document.createElement('td');
        powerCell.className = 'numeric';
        powerCell.textContent = (facility.TotalPower || 0).toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        });

        // Municipality
        const municipalityCell = document.createElement('td');
        municipalityCell.textContent = facility.Municipality || '';

        // Canton
        const cantonCell = document.createElement('td');
        cantonCell.textContent = facility.Canton || '';

        // Start date
        const startCell = document.createElement('td');
        startCell.textContent = facility.BeginningOfOperation || '';

        // GPS indicator
        const gpsCell = document.createElement('td');
        gpsCell.className = 'gps-indicator';
        if (facility.lat && facility.lon) {
            gpsCell.innerHTML = '<span class="gps-yes">✓</span>';
        } else {
            gpsCell.innerHTML = '<span class="gps-no">✗</span>';
        }

        row.appendChild(sourceCell);
        row.appendChild(powerCell);
        row.appendChild(municipalityCell);
        row.appendChild(cantonCell);
        row.appendChild(startCell);
        row.appendChild(gpsCell);
        tbody.appendChild(row);
    });

    // Update pagination controls
    const totalPages = Math.ceil(facilities.onTable.length / TABLE_NUM_ROWS);
    document.getElementById('currentPageNumber').textContent = p;
    document.getElementById('totalPages').textContent = totalPages;
    document.getElementById('firstPage').disabled = p <= 1;
    document.getElementById('prevPage').disabled = p <= 1;
    document.getElementById('nextPage').disabled = p >= totalPages;
    document.getElementById('lastPage').disabled = p >= totalPages;

    renderFacilitiesCategories();

    serializeStateToURL();
}

///////////////////////////////////////////////////////////////////////////////
// Search and filters
///////////////////////////////////////////////////////////////////////////////

function callbackFacilitiesCategories(e) {
    if (e.target.type !== 'checkbox') { return; }
    const allCheckbox = document.getElementById('cat-select-all');
    if (e.target.id === allCheckbox.id) {
        // Select/deselect all
        const checked = e.target.checked;
        document.querySelectorAll('#categoryTableBody input[type="checkbox"]').forEach(cb => {
            if (cb.id !== allCheckbox.id) cb.checked = checked;
        });
        appState.selectedFacilitiesCategories = checked ? [...facilities.categories] : [];
    } else {
        appState.selectedFacilitiesCategories = Array
            .from(document.querySelectorAll('#categoryTableBody input[type="checkbox"]:not(#cat-select-all):checked'))
            .map(cb => cb.value);
        // Sync select-all checkbox
        const allChecked = appState.selectedFacilitiesCategories.length === facilities.categories.length;
        allCheckbox.checked = allChecked;
    }
    filterFacilities();
    renderTableOrMap();
}

let searchTimeout = null;
function callbackSearchInput(e) {
    const searchText = e.target.value;
    // Debounce search (reduce expensive filter computations).
    if (searchTimeout) {
        clearTimeout(searchTimeout);
    }
    searchTimeout = setTimeout(() => {
        appState.searchTokens = searchText.toLowerCase().split(/\s+/).filter(token => token.length > 0);
        filterFacilities();
        renderTableOrMap();
    }, DEBOUNCE_MS);
}

function callbackPowerSlider(values, handle) {
    function formatPower(power) {
        if (power >= 1000000) {
            return `${(power / 1000000).toFixed(1)} GW`;
        } else if (power >= 1000) {
            return `${(power / 1000).toFixed(1)} MW`;
        } else {
            return `${power.toFixed(1)} kW`;
        }
    }
    appState.minPower = Math.pow(10, values[0] - 1);
    appState.maxPower = Math.pow(10, values[1] - 1);
    const minDisplay = formatPower(appState.minPower);
    const maxDisplay = formatPower(appState.maxPower);

    document.getElementById('currentPowerRange').textContent = `${minDisplay} - ${maxDisplay}`;
    filterFacilities();
    if (isInitializing) {
        return;
    }
    renderTableOrMap();
}

function facilityMatchesSearch(f) {
    if (appState.searchTokens.length === 0) return true;

    // Fields to search: Energy Source, Power, Municipality, Canton, Date started
    const searchableText = [
        f.SubCategory || '',
        (f.TotalPower || '').toString(),
        f.BeginningOfOperation || '',
        'city:' + (f.Municipality || ''),
        'canton:' + (f.Canton || ''),
        'year:' + (f.BeginningOfOperation || '').slice(0, 4),
    ].join(' ').toLowerCase();

    // All tokens must be found as substrings
    return appState.searchTokens.every(token => searchableText.includes(token));
}

function filterFacilities() {
    facilities.categoryStats = {};
    facilities.categories.forEach(category => {
        facilities.categoryStats[category] = { count: 0, capacity: 0 };
    });

    let totalCapacity = 0;
    let totalCount = 0;
    facilities.filtered = [];

    facilities.all
        .filter(f => f.TotalPower >= appState.minPower && f.TotalPower <= appState.maxPower)
        .filter(f => facilityMatchesSearch(f))
        .forEach(f => {
            const category = f.SubCategory;
            const MW = f.TotalPower / 1000;
            facilities.categoryStats[category].count++;
            facilities.categoryStats[category].capacity += MW;
            // Add to filtered facilities if category is selected
            if (appState.selectedFacilitiesCategories.includes(category)) {
                facilities.filtered.push(f);
                totalCapacity += MW;
                totalCount++;
            }
        });
    facilities.categoryStats['Total'] = { count: totalCount, capacity: totalCapacity };
}

function renderTableOrMap() {
    if (appState.isTableView) {
        renderTable(true);
    } else {
        renderMap();
    }
}

function modeFacilities() {
    const facilitiesBtn = document.getElementById('facilitiesMode');
    const productionBtn = document.getElementById('productionMode');
    facilitiesBtn.classList.add('active');
    productionBtn.classList.remove('active');

    // Show facilities controls, hide production controls
    document.querySelectorAll('.facilities-controls').forEach(el => el.style.display = 'block');
    document.querySelectorAll('.production-controls').forEach(el => el.style.display = 'none');
    document.getElementById('annotations').style.display = 'block';

    // Show appropriate view
    document.getElementById('productionView').style.display = 'none';
    document.getElementById('tableView').style.display = appState.isTableView ? 'block' : 'none';
    document.getElementById('map').style.display = appState.isTableView ? 'none' : 'block';

    // Update search box
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = appState.searchTokens.join(' ');
    }

    filterFacilities();
    renderTableOrMap();
}

function modeProduction() {
    const facilitiesBtn = document.getElementById('facilitiesMode');
    const productionBtn = document.getElementById('productionMode');
    facilitiesBtn.classList.remove('active');
    productionBtn.classList.add('active');

    // Hide facilities controls, show production controls
    document.querySelectorAll('.facilities-controls').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.production-controls').forEach(el => el.style.display = 'block');
    if (lastUpdate) {
        document.getElementById('annotations').style.display = 'block';
        document.getElementById('annotations').innerHTML =
            `Last data update: ${lastUpdate}`;
    } else {
        document.getElementById('annotations').style.display = 'none';
    }

    // Show production view
    document.getElementById('map').style.display = 'none';
    document.getElementById('tableView').style.display = 'none';
    document.getElementById('productionView').style.display = 'block';

    // Initialize or update the chart
    updateProductionChart();
}

function renderFacilitiesCategories() {
    facilities.categories.forEach(category => {
        const stats = facilities.categoryStats[category];
        const countElement = document.getElementById(`count-${category.replace(/\s+/g, '-')}`);
        const capacityElement = document.getElementById(`capacity-${category.replace(/\s+/g, '-')}`);
        if (countElement) countElement.textContent = stats.count.toLocaleString();
        if (capacityElement) capacityElement.textContent = stats.capacity.toFixed(1);
    });
    document.getElementById('totalCount').textContent = facilities.categoryStats['Total'].count.toLocaleString();
    document.getElementById('totalCapacity').textContent = facilities.categoryStats['Total'].capacity.toFixed(1);
}

///////////////////////////////////////////////////////////////////////////////
// Facilities mode, map view
///////////////////////////////////////////////////////////////////////////////

function renderMap() {
    if (appState.isTableView) {
        throw new Error('updateMap called in table view');
    }
    renderFacilitiesCategories();

    const onMap = facilities.filtered.filter(f => f.lat && f.lon)
    const scatterplotLayer = new ScatterplotLayer({
        id: 'facilities',
        data: onMap,
        getPosition: d => [d.lon, d.lat],
        getFillColor: d => FACILITIES_CATEGORY_COLORS[d.SubCategory] || [128, 128, 128],
        getRadius: d => 12 * Math.pow(Math.log(d.TotalPower + 1), 2),
        radiusUnits: 'meters',
        opacity: 0.4,
        pickable: true,
        radiusMinPixels: 2,
        radiusMaxPixels: 100,
        updateTriggers: {
            getFillColor: appState.selectedFacilitiesCategories,
            getRadius: [appState.minPower, appState.maxPower]
        }
    });

    deckgl.setProps({ layers: [scatterplotLayer] });

    console.log('lastUpdate', lastUpdate);
    document.getElementById('annotations').innerHTML =
        `${facilities.filtered.length.toLocaleString()} facilities match filters.<br/>Map shows ${onMap.length.toLocaleString()} facilities.` +
        `<span class="info-asterisk">*` +
        `<span class="tooltip">${(facilities.filtered.length - onMap.length).toLocaleString()} facilities lack GPS coordinates or geocodable addresses.</span>` +
        `</span>` +
        (lastUpdate ? `<br/>Last data update: ${lastUpdate}` : '');

    serializeStateToURL();
}

///////////////////////////////////////////////////////////////////////////////
// Production mode
///////////////////////////////////////////////////////////////////////////////

function createProductionChart() {
    const ctx = document.getElementById('productionChart').getContext('2d');

    productionChart = new Chart(ctx, {
        type: 'bar',
        data: {
            datasets: []
        },
        options: {
            animation: false,
            normalized: true,
            parsing: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            onHover: (event, activeElements, chart) => {
                const canvas = chart.canvas;
                canvas.style.cursor = activeElements.length > 0 ? 'pointer' : 'grab';
            },
            plugins: {
                legend: {
                    position: 'top',
                },
                title: {
                    display: true,
                    text: 'Swiss energy production over time'
                },
                zoom: {
                    zoom: {
                        wheel: {
                            enabled: true,
                            speed: 0.1
                        },
                        pinch: {
                            enabled: true
                        },
                        drag: {
                            enabled: false
                        },
                        mode: 'x',
                        onZoomComplete: ({ chart }) => {
                            updateTimeUnit(chart);
                            updateProductionChart(chart.scales.x.min, chart.scales.x.max);
                            updateProductionStats(chart.scales.x.min, chart.scales.x.max);
                            appState.productionChart.xmin = chart.scales.x.min;
                            appState.productionChart.xmax = chart.scales.x.max;
                            serializeStateToURL();
                        }
                    },
                    pan: {
                        enabled: true,
                        mode: 'x',
                        onPanComplete: ({ chart }) => {
                            updateProductionStats(chart.scales.x.min, chart.scales.x.max);
                            appState.productionChart.xmin = chart.scales.x.min;
                            appState.productionChart.xmax = chart.scales.x.max;
                            serializeStateToURL();
                        }
                    },
                    limits: {
                        x: {
                            min: 'original',
                            max: 'original',
                            minRange: 7 * 24 * 60 * 60 * 1000,
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45,
                    },
                    time: {
                        unit: 'quarter',
                        displayFormats: {
                            day: 'dd MMM yyyy',
                            week: 'dd MMM yyyy',
                            month: 'MMM yyyy',
                            quarter: 'MMM yyyy',
                            year: 'yyyy'
                        },
                        tooltipFormat: 'MMM yyyy'
                    },
                    title: {
                        display: true,
                        text: 'Date'
                    },
                    stacked: true
                },
                y: {
                    title: {
                        display: true,
                        text: 'Production (GWh)'
                    },
                    beginAtZero: true,
                    stacked: true
                }
            },
            datasets: {
                bar: {
                    categoryPercentage: 0.9, // Reduce space between bar groups
                    barPercentage: 1.0, // Bars take full width of their category
                }
            },
        }
    });
    window.productionChartKeyListener = (e) => {
        if (!appState.isProductionMode || !productionChart) return;
        switch (e.key) {
            case '-': case '_':
                e.preventDefault();
                productionChart.zoom(0.8);
                productionChart.options.plugins.zoom.zoom.onZoomComplete({ chart: productionChart });
                break;
            case '+': case '=':
                e.preventDefault();
                productionChart.zoom(1.2);
                productionChart.options.plugins.zoom.zoom.onZoomComplete({ chart: productionChart });
                break;
            case 'ArrowLeft':
                e.preventDefault();
                productionChart.pan({ x: 100 });
                productionChart.options.plugins.zoom.pan.onPanComplete({ chart: productionChart });
                break;
            case 'ArrowRight':
                e.preventDefault();
                productionChart.pan({ x: -100 });
                productionChart.options.plugins.zoom.pan.onPanComplete({ chart: productionChart });
                break;
        }
    };
    document.addEventListener('keydown', window.productionChartKeyListener);
}

function aggregateDataByTimeUnit(unit) {
    const aggregated = {};

    productionData.forEach(record => {
        const date = new Date(record.date);
        date.setHours(0, 0, 0, 0);
        switch (unit) {
            case 'week':
                date.setDate(date.getDate() - date.getDay());
                break;
            case 'month':
                date.setDate(1);
                break;
            case 'quarter':
                date.setFullYear(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1);
                break;
            case 'year':
                date.setFullYear(date.getFullYear(), 0, 1);
                break;
            default:
                break;
        }
        const key = date.getTime();
        if (!aggregated[key]) {
            aggregated[key] = {
                date: key,
                prod: new Array(6).fill(0),
                count: 0
            };
        }
        record.prod.forEach((value, index) => {
            aggregated[key].prod[index] += value;
        });
        aggregated[key].count += 1;
    });

    // Create time-sorted array of aggregated data
    return Object.values(aggregated).map(item => {
        return {
            date: item.date,
            prod: item.prod
        };
    }).sort((a, b) => a.date - b.date);
}

function updateTimeUnit(chart) {
    if (!chart || !chart.scales || !chart.scales.x || !chart.scales.x.max || !chart.scales.x.min) {
        console.warn('Chart scales not available for time unit update');
        return;
    }

    // chart.scales.x.{max,min} are Unix timestamps in milliseconds
    const range = chart.scales.x.max - chart.scales.x.min;
    const days = range / 24 / 60 / 60 / 1000;

    let unit = 'quarter', tooltipFormat = 'MMM yyyy';
    if (days <= 90) { unit = 'day'; tooltipFormat = 'dd MMM yyyy'; }
    else if (days <= 365) { unit = 'week'; tooltipFormat = 'dd MMM yyyy'; }
    else if (days <= 1095) { unit = 'month'; tooltipFormat = 'MMM yyyy'; } // 3 years

    const currentUnit = chart.options.scales.x.time.unit;
    if (currentUnit === unit) return;
    // console.log(`Zoom: ${days.toFixed(0)} days visible, switching ${currentUnit} -> ${unit}`);
    chart.options.scales.x.time.unit = unit;
    chart.options.scales.x.time.tooltipFormat = tooltipFormat;
}

function updateProductionStats(minDate, maxDate) {
    const totals = new Array(6).fill(0);
    let count = 0;

    productionData.forEach(record => {
        if (record.date < minDate || record.date > maxDate) return;
        record.prod.forEach((value, index) => {
            totals[index] += value;
        });
        count++;
    });

    PRODUCTION_CATEGORIES.forEach((category, index) => {
        const avgElement = document.getElementById(`prod-avg-${index}`);
        if (avgElement) {
            const avg = totals[index] / count;
            avgElement.textContent = avg.toFixed(1);
        }
    });
}

function updateProductionChart(minDate, maxDate) {
    if (!productionChart) {
        createProductionChart();
    }

    let currentUnit = productionChart.options.scales.x.time.unit

    const aggregatedData = aggregateDataByTimeUnit(currentUnit);
    const datasets = [];

    [...appState.selectedProductionCategories].reverse().forEach((category, index) => {
        const categoryIndex = PRODUCTION_CATEGORIES.indexOf(category);
        if (categoryIndex === -1) return;

        const data = aggregatedData.map(record => ({
            x: record.date,
            y: record.prod[categoryIndex]
        }));

        datasets.push({
            label: category,
            data: data,
            backgroundColor: `rgba(${PRODUCTION_CATEGORY_COLORS[category].join(',')}, 0.8)`,
            borderColor: `rgb(${PRODUCTION_CATEGORY_COLORS[category].join(',')})`,
            borderWidth: 1,
            stack: 'production'
        });
    });

    productionChart.data.datasets = datasets;
    productionChart.options.plugins.title.text = `Energy production (GWh ${TIME_UNIT_NAMES[currentUnit]})`;

    // Set zoom and pan limits to data range
    if (minDate && maxDate) {
        productionChart.scales.x.min = minDate;
        productionChart.scales.x.max = maxDate;
    } else if (appState.productionChart.xmin && appState.productionChart.xmax) {
        // Use saved bounds from state
        productionChart.scales.x.min = appState.productionChart.xmin;
        productionChart.scales.x.max = appState.productionChart.xmax;
    } else {
        // Default to full data range
        productionChart.scales.x.min = aggregatedData[0].date;
        productionChart.scales.x.max = aggregatedData[aggregatedData.length - 1].date;
    }
    productionChart.options.plugins.zoom.limits.x.min = aggregatedData[0].date;
    productionChart.options.plugins.zoom.limits.x.max = aggregatedData[aggregatedData.length - 1].date;
    productionChart.update();
}
