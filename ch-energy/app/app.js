///////////////////////////////////////////////////////////////////////////////
// Constants
///////////////////////////////////////////////////////////////////////////////

// Application modes enum
const AppMode = {
    FACILITIES: 1,
    PRODUCTION: 2,
    TRADE: 3,
    ABOUT: 4
};

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
    'hour': 'Hourly',
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

// Trade categories (countries Switzerland trades with)
const TRADE_CATEGORIES = [
    'Austria',
    'Germany',
    'France',
    'Italy'
];

// Color palette for trade categories (countries)
const TRADE_CATEGORY_COLORS = {
    'Austria': [244, 67, 54],      // Red
    'Germany': [255, 193, 7],      // Amber
    'France':  [33, 150, 243],     // Blue
    'Italy': [76, 175, 80]         // Green
};

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

let fresh = {
    table: false,
    map: false,
    production: false,
    trade: false
};

let facilities = {
    all: [],                     // All power facilities.
    filtered: [],                // Facilities that match the current selection (category, power range)
    onMap: [],                   // Facilities that are rendered on the map (have GPS coordinates)
    categories: [],              // All categories (solar, hydro, etc.)
    categoryStats: {}            // Category statistics (count and totals by category)
};

// Production data state
let productionData = [];         // Historical production data
let productionView = null;       // State for production view

// Trade data state
let tradeData = [];              // Historical trade data
let tradeView = null;            // State for trade view

// Global state object
const appState = {
    // Top-level toggle between modes
    currentMode: AppMode.FACILITIES, // AppMode.FACILITIES, AppMode.PRODUCTION, or AppMode.TRADE

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

    // Trade mode state
    selectedTradeCategories: null,

    // Map view state
    mapView: {
        latitude: 46.8182,
        longitude: 8.2275,
        zoom: 8
    },

    // Production chart state
    productionChart: {
        xmin: new Date('2015-01-01').getTime(),
        xmax: Infinity
    },

    // Trade chart state
    tradeChart: {
        xmin: new Date('2017-01-01').getTime(), // Trade data starts from 2017
        xmax: Infinity
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
        if (state.currentMode !== undefined) {
            appState.currentMode = state.currentMode;
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
        if (Array.isArray(state.selectedTradeCategories)) {
            appState.selectedTradeCategories = state.selectedTradeCategories
                .filter(c => typeof c === 'string' && TRADE_CATEGORIES.includes(c));
        }
        if (state.mapView && typeof state.mapView === 'object') {
            decodeFloat(state.mapView.latitude, (val) => appState.mapView.latitude = val, -90, 90);
            decodeFloat(state.mapView.longitude, (val) => appState.mapView.longitude = val, -180, 180);
            decodeFloat(state.mapView.zoom, (val) => appState.mapView.zoom = val, 0);
        }
        if (state.productionChart && typeof state.productionChart === 'object') {
            decodeFloat(state.productionChart.xmin, (val) => appState.productionChart.xmin = val, 0);
            decodeFloat(state.productionChart.xmax, (val) => appState.productionChart.xmax = val, appState.productionChart.xmin);
        }
        if (state.tradeChart && typeof state.tradeChart === 'object') {
            decodeFloat(state.tradeChart.xmin, (val) => appState.tradeChart.xmin = val, 0);
            decodeFloat(state.tradeChart.xmax, (val) => appState.tradeChart.xmax = val, appState.tradeChart.xmin);
        }
    } catch (error) {
        console.warn('Failed to deserialize state from URL:', error);
    }
}

///////////////////////////////////////////////////////////////////////////////
// Framework for time series charts
///////////////////////////////////////////////////////////////////////////////

class TimeSeriesChart {
    constructor(config) {
        this.canvasId = config.canvasId;
        this.categories = config.categories;
        this.colors = config.colors;
        this.data = config.data;
        this.chartType = config.chartType || 'bar';
        this.state = config.state;
        this.selectedCategories = config.selectedCategories;

        this.freshKey = config.freshKey;
        this.minRange = config.minRange || 7 * 24 * 60 * 60 * 1000; // one week minimum

        this.chartTitle = config.chartTitle;
        this.yAxisTitle = config.yAxisTitle || 'Value';
        this.beginAtZero = config.beginAtZero === undefined ? true : config.beginAtZero;

        this.categoryAggregator = config.categoryAggregator;
        this.categoryValueElementId = config.categoryValueElementId;
        this.categoryTotalElementId = config.categoryTotalElementId;
        this.categoryAllElementId = config.categoryAllElementId;
        this.categoryTableElementId = config.categoryTableElementId;
        this.resetZoomElementId = config.resetZoomElementId;
        this.displayValueProcessor = config.displayValueProcessor;

        this.createChart();
        this.renderControls();

        const min = Math.max(this.state.xmin, new Date('2015-01-01').getTime());
        const max = Math.min(this.state.xmax, new Date().getTime());
        this.chart.options.scales.x.min = min;
        this.chart.options.scales.x.max = max;
        this.chart.update();
        this.updateTimeUnit(this.chart);
        this.updateCategories(min, max);

        const canvas = document.getElementById(this.canvasId);
        canvas.tabIndex = 0; // Make canvas focusable
        canvas.addEventListener('keydown', this.callbackKeyDown.bind(this));
        document.getElementById(this.resetZoomElementId).addEventListener('click', this.callbackResetZoom.bind(this));
        document.getElementById(this.categoryTableElementId).addEventListener('change', this.callbackCategoryChange.bind(this));
    }

    createChart() {
        const ctx = document.getElementById(this.canvasId).getContext('2d');
        const config = {
            type: this.chartType,
            data: { datasets: [] },
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
                        position: 'top'
                    },
                    title: {
                        display: true,
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
                            onZoomComplete: ({chart}) => this.callbackZoom(chart)
                        },
                        pan: {
                            enabled: true,
                            mode: 'x',
                            onPanComplete: ({chart}) => this.callbackPan(chart)
                        },
                        limits: {
                            x: {
                                min: 'original',
                                max: 'original',
                                minRange: this.minRange
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        ticks: {
                            maxRotation: 45,
                            minRotation: 45
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
                            text: this.yAxisTitle
                        },
                        beginAtZero: this.beginAtZero,
                        stacked: true
                    }
                },
                datasets: {
                    bar: {
                        categoryPercentage: 0.9, // Reduce space between bar groups
                        barPercentage: 1.0, // Bars take full width of their category
                    }
                }
            }
        };
        this.chart = new Chart(ctx, config);
    }

    renderControls() {
        const container = document.getElementById(this.categoryTableElementId);
        container.innerHTML = '';

        // Select/Deselect all checkbox
        const allCheckbox = document.createElement('input');
        allCheckbox.type = 'checkbox';
        allCheckbox.className = 'category-checkbox';
        allCheckbox.id = this.categoryAllElementId;
        allCheckbox.checked = this.selectedCategories.length === this.categories.length;
        const allLabel = document.createElement('label');
        allLabel.htmlFor = this.categoryAllElementId;
        allLabel.textContent = 'Select/Deselect All';
        const allTd = document.createElement('td');
        allTd.colSpan = 2;
        allTd.appendChild(allCheckbox);
        allTd.appendChild(allLabel);
        let tr = document.createElement('tr');
        tr.appendChild(allTd);
        container.appendChild(tr);

        this.categories.forEach((category, index) => {
            tr = document.createElement('tr');

            // Country column with checkbox and color indicator
            const sourceCell = document.createElement('td');
            sourceCell.className = 'source-cell';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'category-checkbox';
            checkbox.id = `${this.categoryAllElementId}-${index}`;
            checkbox.value = category;
            checkbox.checked = this.selectedCategories.includes(category);

            const label = document.createElement('label');
            label.className = 'category-label';
            label.htmlFor = checkbox.id;

            const colorIndicator = document.createElement('span');
            colorIndicator.className = 'color-indicator';
            const color = this.colors[category] || [128, 128, 128];
            colorIndicator.style.backgroundColor = `rgb(${color.join(',')})`;

            const text = document.createElement('span');
            text.textContent = category;

            label.appendChild(colorIndicator);
            label.appendChild(text);
            sourceCell.appendChild(checkbox);
            sourceCell.appendChild(label);

            // Net import column
            const netImportCell = document.createElement('td');
            netImportCell.className = 'count-cell';
            netImportCell.id = this.categoryValueElementId + index;

            tr.appendChild(sourceCell);
            tr.appendChild(netImportCell);
            container.appendChild(tr);
        });
    }

    updateCategories(minDate, maxDate) {
        const averages = this.categoryAggregator(this.data, minDate, maxDate);
        let selectedTotal = 0;
        this.categories.forEach((category, index) => {
            const element = document.getElementById(`${this.categoryValueElementId}${index}`);
            if (!element) {
                console.warn(`Category value element not found: ${this.categoryValueElementId}${index}`);
                return;
            }
            element.textContent = averages[index].toFixed(1);
            if (this.selectedCategories.includes(category)) {
                selectedTotal += averages[index];
            }
        });
        const totalElement = document.getElementById(this.categoryTotalElementId);
        totalElement.textContent = selectedTotal.toFixed(1);
    }

    updateChart(minDate, maxDate) {
        function aggregateByTimeUnit(data, unit) {
            const aggregated = {};

            const numFields = data[0].val.length;
            for (const record of data) {
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
                        val: new Array(numFields).fill(0),
                    };
                }
                for (let i = 0; i < record.val.length; i++) {
                    aggregated[key].val[i] += record.val[i];
                }
            }

            // Create time-sorted array of aggregated data
            return Object.values(aggregated).map(item => {
                return {
                    date: item.date,
                    val: item.val
                };
            }).sort((a, b) => a.date - b.date);
        }

        document.getElementById(this.canvasId).focus();
        if (fresh[this.freshKey]) { return; }
        const chart = this.chart;
        let currentUnit = chart.options.scales.x.time.unit;
        const aggregatedData = aggregateByTimeUnit(this.data, currentUnit);

        const datasets = [];

        [...this.selectedCategories].forEach((category, _) => {
            const categoryIndex = this.categories.indexOf(category);
            if (categoryIndex === -1) return;
            const color = this.colors[category] || [128, 128, 128];
            const data = this.displayValueProcessor(aggregatedData, categoryIndex);

            datasets.push({
                label: category,
                data: data,
                backgroundColor: `rgba(${color.join(',')}, 0.8)`,
                borderColor: `rgb(${color.join(',')})`,
                borderWidth: 1,
                stack: 'foo'
            });
        });

        chart.data.datasets = datasets;
        chart.options.plugins.title.text = this.chartTitle + ' (GWh ' + TIME_UNIT_NAMES[currentUnit] + ')';

        // Set zoom and pan limits to data range
        if (minDate && maxDate) {
            chart.scales.x.min = minDate;
            chart.scales.x.max = maxDate;
        } else if (appState.productionChart.xmin && appState.productionChart.xmax) {
            // Use saved bounds from state
            chart.scales.x.min = appState.productionChart.xmin;
            chart.scales.x.max = appState.productionChart.xmax;
        } else {
            // Default to full data range
            chart.scales.x.min = aggregatedData[0].date;
            chart.scales.x.max = aggregatedData[aggregatedData.length - 1].date;
        }
        chart.options.plugins.zoom.limits.x.min = aggregatedData[0].date;
        chart.options.plugins.zoom.limits.x.max = aggregatedData[aggregatedData.length - 1].date;
        chart.update();
        fresh[this.freshKey] = true;
    }

    callbackCategoryChange(e) {
        const allCheckbox = document.getElementById(this.categoryAllElementId);
        const checked = e.target.checked;
        if (e.target.id === allCheckbox.id) {
            // Select/deselect all
            document.querySelectorAll(`#${this.categoryTableElementId} input[type="checkbox"]`).forEach(cb => {
                if (cb.id !== allCheckbox.id) cb.checked = checked;
            });
            appState[this.selectedCategoriesKey] = checked ? [...this.categories] : [];
        } else {
            appState[this.selectedCategoriesKey] = Array
                .from(document.querySelectorAll(`#${this.categoryTableElementId} input[type="checkbox"]:not(#${this.categoryAllElementId}):checked`))
                .map(cb => cb.value);
            // Sync select-all checkbox
            const allChecked = appState[this.selectedCategoriesKey].length === this.categories.length;
            allCheckbox.checked = allChecked;
        }

        fresh[this.freshKey] = false;
        this.updateChart();
        this.updateCategories();
        serializeStateToURL();
    }

    callbackResetZoom() {
        this.chart.resetZoom();
    }

    callbackZoom() {
        fresh[this.freshKey] = false;
        this.updateTimeUnit();
        this.updateChart(this.chart.scales.x.min, this.chart.scales.x.max);
        this.updateCategories(this.chart.scales.x.min, this.chart.scales.x.max);
        this.state.xmin = this.chart.scales.x.min;
        this.state.xmax = this.chart.scales.x.max;
        serializeStateToURL();
    }

    callbackPan(chart) {
        this.updateCategories(chart.scales.x.min, chart.scales.x.max);
        this.state.xmin = chart.scales.x.min;
        this.state.xmax = chart.scales.x.max;
        serializeStateToURL();
    }

    callbackKeyDown(e) {
        switch (e.key) {
            case '-': case '_':
                e.preventDefault();
                this.chart.zoom(0.8);
                this.callbackZoom();
                break;
            case '+': case '=':
                e.preventDefault();
                this.chart.zoom(1.2);
                this.callbackZoom();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.chart.pan({ x: 100 });
                this.callbackPan();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.chart.pan({ x: -100 });
                this.callbackPan();
                break;
        }
    }

    updateTimeUnit() {
        const chart = this.chart;
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
        chart.options.scales.x.time.unit = unit;
        chart.options.scales.x.time.tooltipFormat = tooltipFormat;
    }
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
                    top: '110px',
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
                    top: '150px',
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

        // Download trade data.
        const tradeResponse = await fetch(`data/trade.json?v=${ts}`);
        if (!tradeResponse.ok) {
            throw new Error(`Failed to load trade data: ${tradeResponse.status} ${tradeResponse.statusText}`);
        }
        tradeData = await tradeResponse.json();
        tradeData.map(d => {
            d.date = new Date(d.date); // Parse ISO datetime string
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
        if (appState.selectedTradeCategories === null) {
            // Initialize with all trade categories on first load (=== null)
            appState.selectedTradeCategories = [...TRADE_CATEGORIES];
        }

        // Hide loading overlay after successful data load
        document.getElementById('loadingOverlay').style.display = 'none';

        console.log(`Loaded ${facilities.all.length} facilities, ${numFacilitiesWithCoords} with coordinates`);
        console.log(`Loaded ${productionData.length} days of production data`);
        console.log(`Loaded ${tradeData.length} days of trade data`);
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

    function _renderSearchInput() {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.value = appState.searchTokens.join(' ');
        }
    }

    function _renderFacilitiesCheckboxes() {
        const container = document.getElementById('facilitiesCategoryTableBody');
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

    _renderPowerSlider();
    _renderSearchInput();
    _renderFacilitiesCheckboxes();
    setupEventHandlers();
    sortFacilities(appState.currentSort.column, appState.currentSort.sortAscending);
    filterFacilities();

    prodConfig = {
        canvasId: 'productionChart',
        categories: PRODUCTION_CATEGORIES,
        colors: PRODUCTION_CATEGORY_COLORS,
        data: productionData,
        state: appState.productionChart,
        selectedCategories: appState.selectedProductionCategories,

        freshKey: 'production',
        chartTitle: 'Energy production',
        yAxisTitle: 'Production (GWh)',
        beginAtZero: true,
        startDate: '2015-01-01',

        categoryAggregator: productionCategoryAggregator,
        categoryValueElementId: 'prod-avg-',
        categoryTotalElementId: 'totalProduction',
        categoryAllElementId: 'production-cat-select-all',
        categoryTableElementId: 'productionCategoryTableBody',
        resetZoomElementId: 'resetProductionZoom',
        displayValueProcessor: productionValueProcessor,
    }

    tradeConfig = {
        canvasId: 'tradeChart',
        categories: TRADE_CATEGORIES,
        colors: TRADE_CATEGORY_COLORS,
        data: tradeData,
        state: appState.tradeChart,
        selectedCategories: appState.selectedTradeCategories,

        freshKey: 'trade',

        chartTitle: 'Energy trade (imports - exports)',
        yAxisTitle: 'Net (imports - exports) (GWh)',
        beginAtZero: false,
        startDate: '2017-01-01',

        categoryAggregator: tradeCategoryAggregator,
        categoryValueElementId: 'trade-net-',
        categoryTotalElementId: 'totalTrade',
        categoryAllElementId: 'trade-cat-select-all',
        categoryTableElementId: 'tradeCategoryTableBody',
        resetZoomElementId: 'resetTradeZoom',
        displayValueProcessor: tradeValueProcessor,
    }

    productionView = new TimeSeriesChart(prodConfig);
    tradeView = new TimeSeriesChart(tradeConfig);

    // Initialize the correct mode
    switch (appState.currentMode) {
        case AppMode.PRODUCTION:
            modeProduction();
            break;
        case AppMode.TRADE:
            modeTrade();
            break;
        case AppMode.ABOUT:
            modeAbout();
            break;
        default:
            modeFacilities();
            break;
    }
}

function setupEventHandlers() {
    setupTableEventHandlers();

    const facilitiesTab = document.getElementById('facilitiesTab');
    facilitiesTab.addEventListener('click', callbackModeFacilities);

    const productionTab = document.getElementById('productionTab');
    productionTab.addEventListener('click', callbackModeProduction);

    const tradeTab = document.getElementById('tradeTab');
    tradeTab.addEventListener('click', callbackModeTrade);

    const aboutTab = document.getElementById('aboutTab');
    aboutTab.addEventListener('click', callbackModeAbout);

    const viewToggle = document.getElementById('viewToggle');
    viewToggle.addEventListener('click', callbackFacilitiesViewToggle);

    const powerRangeSlider = document.getElementById('powerRangeSlider');
    powerRangeSlider.noUiSlider.on('update', callbackPowerSlider);

    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', callbackSearchInput);

    document.getElementById('facilitiesCategoryTableBody').addEventListener('change', callbackFacilitiesCategories);
}

///////////////////////////////////////////////////////////////////////////////
// Mode switching
///////////////////////////////////////////////////////////////////////////////

function callbackModeFacilities() {
    if (appState.currentMode === AppMode.FACILITIES) { return; }
    appState.currentMode = AppMode.FACILITIES;
    modeFacilities();
    serializeStateToURL();
}

function callbackModeProduction() {
    if (appState.currentMode === AppMode.PRODUCTION) { return; }
    appState.currentMode = AppMode.PRODUCTION;
    modeProduction();
    serializeStateToURL();
}

function callbackModeTrade() {
    if (appState.currentMode === AppMode.TRADE) { return; }
    appState.currentMode = AppMode.TRADE;
    modeTrade();
    serializeStateToURL();
}

function callbackModeAbout() {
    if (appState.currentMode === AppMode.ABOUT) { return; }
    appState.currentMode = AppMode.ABOUT;
    modeAbout();
    serializeStateToURL();
}

function activate(mode, controls) {
    document.querySelectorAll('.tab-button').forEach(el => el.classList.remove('active'));
    document.getElementById(mode + 'Tab').classList.add('active');
    document.querySelectorAll('.mode').forEach(el => el.style.display = 'none');
    document.getElementById(mode + 'Mode').style.display = 'block';

    document.querySelectorAll('.control-section').forEach(el => el.style.display = 'none');
    if (controls) {
        document.querySelectorAll('.' + controls).forEach(el => el.style.display = 'block');
    }
}

function setAnnotations() {
    document.getElementById('annotations').style.display = lastUpdate ? 'block' : 'none';
    document.getElementById('annotations').innerHTML = lastUpdate ? `Last data update: ${lastUpdate}` : '';
}

function modeFacilities() {
    activate('facilities', 'facilities-controls');
    renderFacilitiesToggle();
    renderFacilities();
}

function modeProduction() {
    activate('production', 'production-controls');
    setAnnotations();
    productionView.updateChart();
}

function modeTrade() {
    activate('trade', 'trade-controls');
    setAnnotations();
    tradeView.updateChart();
}

function modeAbout() {
    activate('about', null);
    document.getElementById('annotations').style.display = 'none';
}

///////////////////////////////////////////////////////////////////////////////
// Facilities mode view switching
///////////////////////////////////////////////////////////////////////////////

function callbackFacilitiesViewToggle() {
    appState.isTableView = !appState.isTableView;
    renderFacilitiesToggle();
    renderFacilities();
}

function renderFacilitiesToggle() {
    if (appState.isTableView) {
        document.getElementById('map').style.display = 'none';
        document.getElementById('tableView').style.display = 'block';
        document.getElementById('viewToggle').textContent = '🗺️ Map View';
    } else {
        document.getElementById('map').style.display = 'block';
        document.getElementById('tableView').style.display = 'none';
        document.getElementById('viewToggle').textContent = '📊 Table View';
    }
}

function renderFacilities(reset = false) {
    if (!fresh.table || !fresh.map) {
        facilities.categories.forEach(category => {
            const stats = facilities.categoryStats[category];
            const countElement = document.getElementById(`count-${category.replace(/\s+/g, '-')}`);
            const capacityElement = document.getElementById(`capacity-${category.replace(/\s+/g, '-')}`);
            if (countElement) countElement.textContent = stats.count.toLocaleString();
            if (capacityElement) capacityElement.textContent = stats.capacity.toFixed(1);

            const nf = facilities.filtered.length, om = facilities.onMap.length, d = nf - om;
            document.getElementById('annotations').innerHTML = `${nf.toLocaleString()} facilities match filters.<br/>`
            + `Map shows ${om.toLocaleString()} facilities.<span class="info-asterisk">*`
            + `<span class="tooltip">${d.toLocaleString()} facilities lack GPS coordinates or geocodable addresses.</span></span>`
            + (lastUpdate ? `<br/>Last data update: ${lastUpdate}` : '');
            document.getElementById('annotations').style.display = 'block';
        });
        document.getElementById('totalCount').textContent = facilities.categoryStats['Total'].count.toLocaleString();
        document.getElementById('totalCapacity').textContent = facilities.categoryStats['Total'].capacity.toFixed(1);
    }

    if (appState.isTableView) {
        renderTable(reset);
    } else {
        renderMap();
    }
}

///////////////////////////////////////////////////////////////////////////////
// Facilities mode, table view
///////////////////////////////////////////////////////////////////////////////

function callbackPageNumber(e) {
    const totalPages = Math.ceil(facilities.filtered.length / TABLE_NUM_ROWS);

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
            fresh.table = false;
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
            fresh.table = false;
            renderTable();
        }
    });
    document.getElementById('prevPage').addEventListener('click', () => {
        if (appState.currentPage > 1) {
            appState.currentPage--;
            fresh.table = false;
            renderTable();
        }
    });
    document.getElementById('nextPage').addEventListener('click', () => {
        const totalPages = Math.ceil(facilities.filtered.length / TABLE_NUM_ROWS);
        if (appState.currentPage < totalPages) {
            appState.currentPage++;
            fresh.table = false;
            renderTable();
        }
    });
    document.getElementById('lastPage').addEventListener('click', () => {
        const totalPages = Math.ceil(facilities.filtered.length / TABLE_NUM_ROWS);
        if (appState.currentPage < totalPages) {
            appState.currentPage = totalPages;
            fresh.table = false;
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
    fresh.table = false;
    sortFacilities(column, appState.currentSort.sortAscending);
    filterFacilities();
    renderTable();
}

function renderTable(reset = false) {
    if (reset) {
        appState.currentPage = 1;
    }
    serializeStateToURL();

    if (fresh.table && !reset) { return; }

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
    const endIndex = Math.min(startIndex + TABLE_NUM_ROWS, facilities.filtered.length);
    const facilitiesToShow = facilities.filtered.slice(startIndex, endIndex);

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
    const totalPages = Math.ceil(facilities.filtered.length / TABLE_NUM_ROWS);
    document.getElementById('currentPageNumber').textContent = p;
    document.getElementById('totalPages').textContent = totalPages;
    document.getElementById('firstPage').disabled = p <= 1;
    document.getElementById('prevPage').disabled = p <= 1;
    document.getElementById('nextPage').disabled = p >= totalPages;
    document.getElementById('lastPage').disabled = p >= totalPages;

    fresh.table = true;
}

///////////////////////////////////////////////////////////////////////////////
// Facilities mode, map view
///////////////////////////////////////////////////////////////////////////////

function renderMap() {
    serializeStateToURL();

    if (fresh.map) { return; }

    const scatterplotLayer = new ScatterplotLayer({
        id: 'facilities',
        data: facilities.onMap,
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
    fresh.map = true;
}

///////////////////////////////////////////////////////////////////////////////
// Facilities mode, search and filters
///////////////////////////////////////////////////////////////////////////////

function callbackFacilitiesCategories(e) {
    if (e.target.type !== 'checkbox') { return; }
    const allCheckbox = document.getElementById('cat-select-all');
    if (e.target.id === allCheckbox.id) {
        // Select/deselect all
        const checked = e.target.checked;
        document.querySelectorAll('#facilitiesCategoryTableBody input[type="checkbox"]').forEach(cb => {
            if (cb.id !== allCheckbox.id) cb.checked = checked;
        });
        appState.selectedFacilitiesCategories = checked ? [...facilities.categories] : [];
    } else {
        appState.selectedFacilitiesCategories = Array
            .from(document.querySelectorAll('#facilitiesCategoryTableBody input[type="checkbox"]:not(#cat-select-all):checked'))
            .map(cb => cb.value);
        // Sync select-all checkbox
        const allChecked = appState.selectedFacilitiesCategories.length === facilities.categories.length;
        allCheckbox.checked = allChecked;
    }
    fresh.table = false;
    fresh.map = false;
    filterFacilities();
    renderFacilities(true);
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
        fresh.table = false;
        fresh.map = false;
        filterFacilities();
        renderFacilities(true);
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
    const min = formatPower(appState.minPower), max = formatPower(appState.maxPower);
    document.getElementById('currentPowerRange').textContent = `${min} - ${max}`;
    if (isInitializing) { return; }
    fresh.table = false;
    fresh.map = false;
    filterFacilities();
    renderFacilities(true);
}

function filterFacilities() {
    function searchPredicate(f) {
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

    facilities.categoryStats = {};
    facilities.categories.forEach(category => {
        facilities.categoryStats[category] = { count: 0, capacity: 0 };
    });

    let totalCapacity = 0;
    let totalCount = 0;
    facilities.filtered = [];

    facilities.all
        .filter(f => f.TotalPower >= appState.minPower && f.TotalPower <= appState.maxPower)
        .filter(f => searchPredicate(f))
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
    facilities.onMap = facilities.filtered.filter(f => f.lat && f.lon);
}

///////////////////////////////////////////////////////////////////////////////
// Helpers for time series charts
///////////////////////////////////////////////////////////////////////////////

function productionCategoryAggregator(data, minDate, maxDate) {
    const aves = new Array(PRODUCTION_CATEGORIES.length).fill(0);
    let count = 0;

    for (const record of data) {
        if (record.date < minDate || record.date > maxDate) continue;
        for (let i = 0; i < 4; i++) {
            aves[i] += record.val[i];
        }
        count++;
    }
    for (let i = 0; i < aves.length; i++) {
        aves[i] /= count;
    }
    return aves;
}

function tradeCategoryAggregator(data, minDate, maxDate) {
    const aves = new Array(TRADE_CATEGORIES.length).fill(0);
    let count = 0;

    for (const record of data) {
        if (record.date < minDate || record.date > maxDate) continue;
        for (let i = 0; i < 4; i++) {
            aves[i] += (record.val[i] - record.val[i + 4]) / 1000; // imports @i, exports @i+4
        }
        count++;
    }
    for (let i = 0; i < aves.length; i++) {
        aves[i] /= count;
    }
    return aves;
}

function productionValueProcessor(data, categoryIndex) {
    const v = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        v[i] = {
            x: data[i].date,
            y: data[i].val[categoryIndex]
        };
    }
    return v;
}

function tradeValueProcessor(data, categoryIndex) {
    const v = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const netTrade = (data[i].val[categoryIndex] - data[i].val[categoryIndex + 4]) / 1000; // Convert MWh to GWh
        v[i] = {
            x: data[i].date,
            y: Math.round(netTrade * 10) / 10
        };
    }
    return v;
}
