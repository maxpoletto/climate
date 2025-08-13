let MAPTILER_KEY = null;         // Load from file.
const { Deck, ScatterplotLayer } = deck;
let deckgl;                      // DeckGL instance.

// Global state object
const appState = {
    // Top-level toggle, facilities vs production mode
    isProductionMode: false,

    // Facilities mode state
    isTableView: false,
    currentSort: { column: 'TotalPower', direction: 'desc' },
    currentPage: 1,
    selectedCategories: null,
    minPower: 0.1,
    maxPower: 2000000,
    searchTokens: [],

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

// State deserialization functions
function decodeInt(value, setter, min = 1) {
    if (value !== undefined) {
        const num = parseInt(value);
        if (!isNaN(num) && num >= min) {
            setter(num);
        }
    }
}

function decodeFloat(value, setter, min = null, max = null) {
    if (value !== undefined) {
        const num = parseFloat(value);
        if (!isNaN(num) && (min === null || num >= min) && (max === null || num <= max)) {
            setter(num);
        }
    }
}

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
    }, 300 /* ms */);
}

function deserializeStateFromURL() {
    const params = new URLSearchParams(window.location.search);
    const encodedState = params.get('s');

    if (!encodedState) return;

    try {
        // Decode base64 and parse JSON
        const state = JSON.parse(atob(encodedState));

        // Validate and apply the deserialized state to appState
        if (state.isProductionMode !== undefined) {
            appState.isProductionMode = Boolean(state.isProductionMode);
        }
        if (state.isTableView !== undefined) {
            appState.isTableView = Boolean(state.isTableView);
        }
        if (state.currentSort && typeof state.currentSort === 'object') {
            if (state.currentSort.column && state.currentSort.direction
                && tableColumns.includes(state.currentSort.column)
                && (state.currentSort.direction === 'asc' || state.currentSort.direction === 'desc')) {
                appState.currentSort = {
                    column: String(state.currentSort.column),
                    direction: String(state.currentSort.direction)
                };
            }
        }
        decodeInt(state.currentPage, (val) => appState.currentPage = val);
        if (Array.isArray(state.selectedCategories)) {
            console.log('selectedCategories', state.selectedCategories);
            console.log('categories', categories);
            appState.selectedCategories = state.selectedCategories.filter(c => typeof c === 'string' && categories.includes(c));
            console.log('appState.selectedCategories', appState.selectedCategories);
        }
        decodeFloat(state.minPower, (val) => appState.minPower = val, 0);
        decodeFloat(state.maxPower, (val) => appState.maxPower = val, 0);
        if (Array.isArray(state.searchTokens)) {
            appState.searchTokens = state.searchTokens.filter(t => typeof t === 'string');
        }
        if (Array.isArray(state.selectedProductionCategories)) {
            appState.selectedProductionCategories = state.selectedProductionCategories.filter(c => typeof c === 'string');
        }
        if (state.mapView && typeof state.mapView === 'object') {
            decodeFloat(state.mapView.latitude, (val) => appState.mapView.latitude = val, -90, 90);
            decodeFloat(state.mapView.longitude, (val) => appState.mapView.longitude = val, -180, 180);
            decodeFloat(state.mapView.zoom, (val) => appState.mapView.zoom = val, 0);
        }
        if (state.productionChart && typeof state.productionChart === 'object') {
            if (state.productionChart.xmin !== undefined && state.productionChart.xmin !== null) {
                decodeFloat(state.productionChart.xmin, (val) => appState.productionChart.xmin = val);
            }
            if (state.productionChart.xmax !== undefined && state.productionChart.xmax !== null) {
                decodeFloat(state.productionChart.xmax, (val) => appState.productionChart.xmax = val);
            }
        }
    } catch (error) {
        console.warn('Failed to deserialize state from URL:', error);
    }
    console.log('decoded state', appState);
}

function modeFacilities() {
    const facilitiesBtn = document.getElementById('facilitiesMode');
    const productionBtn = document.getElementById('productionMode');
    facilitiesBtn.classList.add('active');
    productionBtn.classList.remove('active');

    // Show facilities controls, hide production controls
    document.querySelectorAll('.facilities-controls').forEach(el => el.style.display = 'block');
    document.querySelectorAll('.production-controls').forEach(el => el.style.display = 'none');
    document.getElementById('facilityCount').style.display = 'block';

    // Show appropriate view
    document.getElementById('productionView').style.display = 'none';
    if (appState.isTableView) {
        document.getElementById('tableView').style.display = 'block';
        document.getElementById('map').style.display = 'none';
    } else {
        document.getElementById('tableView').style.display = 'none';
        document.getElementById('map').style.display = 'block';
    }

    // Update search box
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = appState.searchTokens.join(' ');
    }

    updateFacilityCategories();
}

function modeProduction() {
    const facilitiesBtn = document.getElementById('facilitiesMode');
    const productionBtn = document.getElementById('productionMode');
    facilitiesBtn.classList.remove('active');
    productionBtn.classList.add('active');

    // Hide facilities controls, show production controls
    document.querySelectorAll('.facilities-controls').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.production-controls').forEach(el => el.style.display = 'block');
    document.getElementById('facilityCount').style.display = 'none';

    // Show production view
    document.getElementById('map').style.display = 'none';
    document.getElementById('tableView').style.display = 'none';
    document.getElementById('productionView').style.display = 'block';

    // Initialize or update the chart
    updateProductionChart();
}

let facilities = [];             // All power facilities.
let numFacilitiesWithCoords = 0; // Number of facilities with GPS coordinates
let filteredFacilities = [];     // Facilities that match the current selection (category, power range)
let mapFacilities = [];          // Facilities that match the current selection (category, power range) and have GPS coordinates
let categories = [];             // All categories (solar, hydro, etc.)
let searchTimeout = null;        // Debounce timeout for search

// Table view state
let displayedFacilities = [];    // Currently displayed facilities in table
const facilitiesPerPage = 50;    // Show 50 facilities per page

// Production data state
let productionData = [];         // Historical production data
let productionChart = null;      // Chart.js instance
let productionCategories = [     // Production categories (from prod.json.gz)
    'Hydro (pumped)',
    'Hydro (river)',
    'Nuclear',
    'Photovoltaic',
    'Thermal',
    'Wind'
];

// Color palette for different categories
const CATEGORY_COLORS = {
    'Photovoltaic': [255, 193, 7],         // Amber/Yellow - solar
    'Hydroelectric power': [33, 150, 243], // Blue - water
    'Wind energy': [76, 175, 80],          // Green - wind
    'Biomass': [139, 69, 19],              // Brown - organic
    'Natural gas': [255, 87, 34],          // Orange-red - gas
    'Waste': [100, 100, 100],              // Gray - waste
    'Nuclear energy': [156, 39, 176],      // Purple - nuclear
    'Crude oil': [96, 125, 139]            // Blue-gray - oil
};

// Color palette for production categories (same colors as categories for matching categories)
const PRODUCTION_COLORS = {
    'Hydro (pumped)': [33, 150, 243],      // Blue
    'Hydro (river)': [21, 101, 192],       // Darker blue
    'Nuclear': [156, 39, 176],             // Purple
    'Photovoltaic': [255, 193, 7],         // Amber/Yellow
    'Thermal': [255, 87, 34],              // Orange-red
    'Wind': [76, 175, 80]                  // Green
};

// Time unit names for production chart title
const timeUnitNames = {
    'day': 'Daily',
    'week': 'Weekly',
    'month': 'Monthly',
    'quarter': 'Quarterly'
};

const tableColumns = ["SubCategory", "TotalPower", "Municipality", "Canton", "BeginningOfOperation", "gps"];

async function loadMapTilerKey() {
    const response = await fetch('maptiler-key.txt');
    if (!response.ok) {
        throw new Error(`Failed to load MapTiler key: ${response.status} ${response.statusText}`);
    }
    const key = await response.text();
    return key.trim();
}

async function initialize() {
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
        return;
    }
    await loadData();

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

    initializeUI();
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

    function _renderFacilityCategories() {
        const container = document.getElementById('categoryTableBody');
        container.innerHTML = '';

        // Select/Deselect all checkbox
        const allCheckbox = document.createElement('input');
        allCheckbox.type = 'checkbox';
        allCheckbox.className = 'category-checkbox';
        allCheckbox.id = 'cat-select-all';
        allCheckbox.checked = appState.selectedCategories.length === categories.length;
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

        categories.forEach(category => {
            tr = document.createElement('tr');

            // Source column with checkbox and color indicator
            const sourceCell = document.createElement('td');
            sourceCell.className = 'source-cell';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'category-checkbox';
            checkbox.id = `cat-${category.replace(/\s+/g, '-')}`;
            checkbox.value = category;
            checkbox.checked = appState.selectedCategories.includes(category);

            const label = document.createElement('label');
            label.className = 'category-label';
            label.htmlFor = checkbox.id;

            const colorIndicator = document.createElement('span');
            colorIndicator.className = 'color-indicator';
            const color = CATEGORY_COLORS[category] || [128, 128, 128];
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
        allCheckbox.checked = appState.selectedProductionCategories.length === productionCategories.length;
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

        productionCategories.forEach((category, index) => {
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
            const color = PRODUCTION_COLORS[category] || [128, 128, 128];
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

    function _initializeFacilitySort() {
        sortFacilities('Municipality', 'asc');
        sortFacilities('TotalPower', 'desc');
        const powerHeader = document.querySelector('th[data-sort="TotalPower"] .sort-indicator');
        if (powerHeader) {
            powerHeader.className = 'sort-indicator desc';
        }
    }

    _renderPowerSlider();
    _renderFacilityCategories();
    _renderProductionCategories();
    _initializeFacilitySort();

    if (appState.isProductionMode) {
        modeProduction();
    } else {
        modeFacilities();
    }

    setupEventListeners();
    updateTableOrMap();
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
        facilities = await facilitiesResponse.json();
        numFacilitiesWithCoords = facilities.filter(f => f.lat && f.lon).length;
        categories = [...new Set(facilities.map(f => f.SubCategory))].sort();

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

        // Import state (if any) from URL.
        deserializeStateFromURL();

        if (appState.selectedProductionCategories === null) {
            // Initialize with all production categories on first load.
            appState.selectedProductionCategories = [...productionCategories];
        }
        if (appState.selectedCategories === null) {
            // Initialize with all categories on first load.
            appState.selectedCategories = [...categories];
        }

        // Hide loading overlay after successful data load
        document.getElementById('loadingOverlay').style.display = 'none';

        console.log(`Loaded ${facilities.length} facilities, ${numFacilitiesWithCoords} with coordinates`);
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

function sortFacilities(column, direction) {
    facilities.sort((a, b) => {
        let aVal, bVal;

        switch (column) {
            case 'TotalPower':
                aVal = a.TotalPower || 0;
                bVal = b.TotalPower || 0;
                return direction === 'asc' ? aVal - bVal : bVal - aVal;

            case 'BeginningOfOperation':
                aVal = new Date(a.BeginningOfOperation || '1900-01-01');
                bVal = new Date(b.BeginningOfOperation || '1900-01-01');
                return direction === 'asc' ? aVal - bVal : bVal - aVal;

            case 'gps':
                aVal = (a.lat && a.lon) ? 1 : 0;
                bVal = (b.lat && b.lon) ? 1 : 0;
                return direction === 'asc' ? aVal - bVal : bVal - aVal;

            default: // String columns
                aVal = (a[column] || '').toString().toLowerCase();
                bVal = (b[column] || '').toString().toLowerCase();
                return direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
    });
}

function updateTableOrMap() {
    if (appState.isTableView) {
        updateTable(true);
    } else {
        updateMap();
    }
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

    productionCategories.forEach((category, index) => {
        const avgElement = document.getElementById(`prod-avg-${index}`);
        if (avgElement) {
            const avg = totals[index] / count;
            avgElement.textContent = avg.toFixed(1);
        }
    });
}

function formatPower(power) {
    if (power >= 1000000) {
        return `${(power / 1000000).toFixed(1)} GW`;
    } else if (power >= 1000) {
        return `${(power / 1000).toFixed(1)} MW`;
    } else {
        return `${power.toFixed(1)} kW`;
    }
}

function setupEventListeners() {

    function _facilityCategories() {
        const allCheckbox = document.getElementById('cat-select-all');
        document.getElementById('categoryTableBody').addEventListener('change', function (e) {
            if (e.target.type === 'checkbox') {
                if (e.target.id === 'cat-select-all') {
                    // Select/deselect all
                    const checked = e.target.checked;
                    document.querySelectorAll('#categoryTableBody input[type="checkbox"]').forEach(cb => {
                        if (cb.id !== 'cat-select-all') cb.checked = checked;
                    });
                    appState.selectedCategories = checked ? [...categories] : [];
                } else {
                    appState.selectedCategories = Array.from(document.querySelectorAll('#categoryTableBody input[type="checkbox"]:not(#cat-select-all):checked')).map(cb => cb.value);
                    // Sync select-all checkbox
                    const allChecked = appState.selectedCategories.length === categories.length;
                    allCheckbox.checked = allChecked;
                }
                updateTotals();
                updateTableOrMap();
            }
        });
    }

    function _facilityMapControls() {
        const powerRangeSlider = document.getElementById('powerRangeSlider');
        powerRangeSlider.noUiSlider.on('update', function (values, handle) {
            appState.minPower = Math.pow(10, values[0] - 1);
            appState.maxPower = Math.pow(10, values[1] - 1);
            const minDisplay = formatPower(appState.minPower);
            const maxDisplay = formatPower(appState.maxPower);

            document.getElementById('currentPowerRange').textContent = `${minDisplay} - ${maxDisplay}`;
            updateFacilityCategories();
            updateTableOrMap();
        });

        const searchInput = document.getElementById('searchInput');
        searchInput.addEventListener('input', (e) => {
            const searchText = e.target.value;

            // Use a timeout to debounce search (reduce expensive filter computations).
            if (searchTimeout) {
                clearTimeout(searchTimeout);
            }
            searchTimeout = setTimeout(() => {
                appState.searchTokens = searchText.toLowerCase().split(/\s+/).filter(token => token.length > 0);
                updateFacilityCategories();
                updateTableOrMap();
            }, 300); // 300ms delay
        });
    }

    function _facilityViewToggle() {
        const viewToggle = document.getElementById('viewToggle');
        viewToggle.addEventListener('click', () => {
            if (appState.isProductionMode) return; // No effect in production mode

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
            updateTableOrMap();
        });
    }

    function _facilityTableControls() {
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
                updateTable();
            }
        });

        document.getElementById('prevPage').addEventListener('click', () => {
            if (appState.currentPage > 1) {
                appState.currentPage--;
                updateTable();
            }
        });

        document.getElementById('nextPage').addEventListener('click', () => {
            const totalPages = Math.ceil(displayedFacilities.length / facilitiesPerPage);
            if (appState.currentPage < totalPages) {
                appState.currentPage++;
                updateTable();
            }
        });

        document.getElementById('lastPage').addEventListener('click', () => {
            const totalPages = Math.ceil(displayedFacilities.length / facilitiesPerPage);
            if (appState.currentPage < totalPages) {
                appState.currentPage = totalPages;
                updateTable();
            }
        });

        // Page number click => inline input
        document.getElementById('currentPageNumber').addEventListener('click', handlePageNumberClick);
    }

    function _modeToggle() {
        const facilitiesBtn = document.getElementById('facilitiesMode');
        const productionBtn = document.getElementById('productionMode');

        facilitiesBtn.addEventListener('click', () => {
            if (!appState.isProductionMode) return;
            appState.isProductionMode = false;
            modeFacilities();
            serializeStateToURL();
        });

        productionBtn.addEventListener('click', () => {
            if (appState.isProductionMode) return;
            appState.isProductionMode = true;
            modeProduction();
            serializeStateToURL();
        });
    }

    function _productionCategories() {
        const allCheckbox = document.getElementById('prod-cat-select-all');
        document.getElementById('productionCategoryTableBody').addEventListener('change', function (e) {
            if (e.target.type === 'checkbox') {
                if (e.target.id === 'prod-cat-select-all') {
                    // Select/deselect all
                    const checked = e.target.checked;
                    document.querySelectorAll('#productionCategoryTableBody input[type="checkbox"]').forEach(cb => {
                        if (cb.id !== 'prod-cat-select-all') cb.checked = checked;
                    });
                    appState.selectedProductionCategories = checked ? [...productionCategories] : [];
                } else {
                    appState.selectedProductionCategories = Array.from(document.querySelectorAll('#productionCategoryTableBody input[type="checkbox"]:not(#prod-cat-select-all):checked')).map(cb => cb.value);
                    // Sync select-all checkbox
                    const allChecked = appState.selectedProductionCategories.length === productionCategories.length;
                    allCheckbox.checked = allChecked;
                }
                updateProductionChart();
                serializeStateToURL();
            }
        });
    }

    function _productionControls() {
        const resetZoomBtn = document.getElementById('resetZoom');
        resetZoomBtn.addEventListener('click', () => {
            if (productionChart) {
                productionChart.resetZoom();
            }
        });
    }

    _facilityCategories();
    _facilityMapControls();
    _facilityViewToggle();
    _facilityTableControls();
    _modeToggle();
    _productionCategories();
    _productionControls();
}

function sortTable(column) {
    const direction = (appState.currentSort.column === column && appState.currentSort.direction === 'asc') ? 'desc' : 'asc';
    appState.currentSort = { column, direction };

    // Clear all sort indicators and set the new one
    document.querySelectorAll('.sort-indicator').forEach(indicator => {
        indicator.className = 'sort-indicator';
    });
    const currentHeader = document.querySelector(`th[data-sort="${column}"] .sort-indicator`);
    currentHeader.className = `sort-indicator ${direction}`;

    // Sort the underlying facilities array
    sortFacilities(column, direction);

    // Re-filter and update display with the newly sorted data
    updateFacilityCategories();
    updateTableOrMap();
}

function updateTable(reset = false) {
    if (!appState.isTableView) {
        throw new Error('updateTable called in map view');
    }
    if (reset) {
        // Use the same filtered facilities as the map (already sorted in underlying array)
        displayedFacilities = [...filteredFacilities];
        // Reset to first page when data changes
        appState.currentPage = 1;
    }

    const tbody = document.getElementById('facilitiesTableBody');
    tbody.innerHTML = '';

    // Calculate pagination
    const startIndex = (appState.currentPage - 1) * facilitiesPerPage;
    const endIndex = Math.min(startIndex + facilitiesPerPage, displayedFacilities.length);
    const facilitiesToShow = displayedFacilities.slice(startIndex, endIndex);

    facilitiesToShow.forEach(facility => {
        const row = document.createElement('tr');

        // Energy Source with color indicator
        const sourceCell = document.createElement('td');
        sourceCell.className = 'energy-source-cell';
        const colorIndicator = document.createElement('span');
        colorIndicator.className = 'table-color-indicator';
        const color = CATEGORY_COLORS[facility.SubCategory] || [128, 128, 128];
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
    updatePaginationControls();
    serializeStateToURL();
}

function createPageNumberSpan() {
    const span = document.createElement('span');
    span.id = 'currentPageNumber';
    span.style.cursor = 'pointer';
    span.style.textDecoration = 'underline';
    span.style.color = '#2196F3';
    span.textContent = appState.currentPage.toString();
    span.addEventListener('click', handlePageNumberClick);
    return span;
}

function createPageNumberInput() {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = totalPages.toString();
    input.value = appState.currentPage.toString();
    input.style.width = '50px';
    input.style.textAlign = 'center';
    input.style.border = '1px solid #2196F3';
    input.style.borderRadius = '3px';
    input.style.padding = '2px';
    input.style.fontSize = '12px';
    return input;
}

function handlePageNumberClick(e) {
    const span = e.target;
    const totalPages = Math.ceil(displayedFacilities.length / facilitiesPerPage);

    // Replace span with input
    const input = createPageNumberInput();
    span.parentNode.replaceChild(input, span);
    input.focus();
    input.select();

    const finishEdit = () => {
        const pageNumber = parseInt(input.value);
        if (pageNumber >= 1 && pageNumber <= totalPages) {
            appState.currentPage = pageNumber;
        }
        // Restore span with current page number
        const newSpan = createPageNumberSpan();
        input.parentNode.replaceChild(newSpan, input);
        if (pageNumber >= 1 && pageNumber <= totalPages) {
            updateTable();
        }
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            input.blur();
        } else if (e.key === 'Escape') {
            // Cancel edit - restore span without changing page
            const newSpan = createPageNumberSpan();
            input.parentNode.replaceChild(newSpan, input);
        }
    });
}

function updatePaginationControls() {
    const totalPages = Math.ceil(displayedFacilities.length / facilitiesPerPage);
    p = appState.currentPage;

    // Update page info
    document.getElementById('currentPageNumber').textContent = p;
    document.getElementById('totalPages').textContent = totalPages;

    // Update button states
    document.getElementById('firstPage').disabled = appState.currentPage <= 1;
    document.getElementById('prevPage').disabled = appState.currentPage <= 1;
    document.getElementById('nextPage').disabled = appState.currentPage >= totalPages;
    document.getElementById('lastPage').disabled = appState.currentPage >= totalPages;
}

function updateFacilityCategories() {
    const categoryStats = {};
    categories.forEach(category => {
        categoryStats[category] = { count: 0, capacity: 0 };
    });

    let totalCapacity = 0;
    let totalCount = 0;
    filteredFacilities = [];

    facilities
        .filter(f => f.TotalPower >= appState.minPower && f.TotalPower <= appState.maxPower)
        .filter(f => facilityMatchesSearch(f))
        .forEach(f => {
            const category = f.SubCategory;

            // Update category stats
            if (categoryStats[category]) {
                categoryStats[category].count++;
                categoryStats[category].capacity += f.TotalPower / 1000; // Convert to MW
            }

            // Add to filtered facilities if category is selected
            if (appState.selectedCategories.includes(category)) {
                filteredFacilities.push(f);
                totalCapacity += f.TotalPower / 1000; // Convert to MW
                totalCount++;
            }
        });
    // Update category display elements
    categories.forEach(category => {
        const stats = categoryStats[category];
        const countElement = document.getElementById(`count-${category.replace(/\s+/g, '-')}`);
        const capacityElement = document.getElementById(`capacity-${category.replace(/\s+/g, '-')}`);
        if (countElement) countElement.textContent = stats.count.toLocaleString();
        if (capacityElement) capacityElement.textContent = stats.capacity.toFixed(1);
    });

    // Update totals
    document.getElementById('totalCount').textContent = totalCount.toLocaleString();
    document.getElementById('totalCapacity').textContent = totalCapacity.toFixed(1);
}

function updateTotals() {
    filteredFacilities = facilities
        .filter(f => appState.selectedCategories.includes(f.SubCategory) && f.TotalPower >= appState.minPower && f.TotalPower <= appState.maxPower)
        .filter(f => facilityMatchesSearch(f));
    const totalCount = filteredFacilities.length;
    const totalCapacity = filteredFacilities.reduce((total, f) => total + f.TotalPower, 0) / 1000; // Convert to MW

    document.getElementById('totalCount').textContent = totalCount.toLocaleString();
    document.getElementById('totalCapacity').textContent = totalCapacity.toFixed(1);
}

function updateMap() {
    if (appState.isTableView) {
        throw new Error('updateMap called in table view');
    }
    mapFacilities = filteredFacilities.filter(f => f.lat && f.lon)
    const scatterplotLayer = new ScatterplotLayer({
        id: 'facilities',
        data: mapFacilities,
        getPosition: d => [d.lon, d.lat],
        getFillColor: d => CATEGORY_COLORS[d.SubCategory] || [128, 128, 128],
        getRadius: d => 12 * Math.pow(Math.log(d.TotalPower + 1), 2),
        radiusUnits: 'meters',
        opacity: 0.4,
        pickable: true,
        radiusMinPixels: 2,
        radiusMaxPixels: 100,
        updateTriggers: {
            getFillColor: appState.selectedCategories,
            getRadius: [appState.minPower, appState.maxPower]
        }
    });

    deckgl.setProps({ layers: [scatterplotLayer] });

    document.getElementById('facilityCount').innerHTML =
        `${filteredFacilities.length.toLocaleString()} facilities match filters.<br/>Map shows ${mapFacilities.length.toLocaleString()} facilities.` +
        `<span class="info-asterisk">*` +
        `<span class="tooltip">${(filteredFacilities.length - mapFacilities.length).toLocaleString()} facilities lack GPS coordinates or geocodable addresses.</span>` +
        `</span>`;

    serializeStateToURL();
}

// Info modal functionality
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
                            updateProductionStats(chart.options.scales.x.min, chart.options.scales.x.max);
                            appState.productionChart.xmin = chart.options.scales.x.min;
                            appState.productionChart.xmax = chart.options.scales.x.max;
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

    const xScale = chart.scales.x;
    // chart.scales.x.{max,min} are Unix timestamps in milliseconds
    const range = xScale.max - xScale.min;
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
    updateProductionChart(xScale.min, xScale.max);
}

function updateProductionChart(minDate, maxDate) {
    if (!productionChart) {
        createProductionChart();
    }

    let currentUnit = productionChart.options.scales.x.time.unit

    const aggregatedData = aggregateDataByTimeUnit(currentUnit);
    const datasets = [];

    [...appState.selectedProductionCategories].reverse().forEach((category, index) => {
        const categoryIndex = productionCategories.indexOf(category);
        if (categoryIndex === -1) return;

        const data = aggregatedData.map(record => ({
            x: record.date,
            y: record.prod[categoryIndex]
        }));

        datasets.push({
            label: category,
            data: data,
            backgroundColor: `rgba(${PRODUCTION_COLORS[category].join(',')}, 0.8)`,
            borderColor: `rgb(${PRODUCTION_COLORS[category].join(',')})`,
            borderWidth: 1,
            stack: 'production'
        });
    });

    productionChart.data.datasets = datasets;
    productionChart.options.plugins.title.text = `Energy production (GWh ${timeUnitNames[currentUnit]})`;

    // Set zoom and pan limits to data range
    if (minDate && maxDate) {
        productionChart.options.scales.x.min = minDate;
        productionChart.options.scales.x.max = maxDate;
    } else if (appState.productionChart.xmin && appState.productionChart.xmax) {
        // Use saved bounds from state
        productionChart.options.scales.x.min = appState.productionChart.xmin;
        productionChart.options.scales.x.max = appState.productionChart.xmax;
    } else {
        // Default to full data range
        productionChart.options.scales.x.min = aggregatedData[0].date;
        productionChart.options.scales.x.max = aggregatedData[aggregatedData.length - 1].date;
    }
    productionChart.options.plugins.zoom.limits.x.min = aggregatedData[0].date;
    productionChart.options.plugins.zoom.limits.x.max = aggregatedData[aggregatedData.length - 1].date;
    productionChart.update();
}
