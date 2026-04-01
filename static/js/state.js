// =============================================================================
// Global State
// =============================================================================
let currentUser = null;
let currentRoom = null;
let roomMembers = [];
let imageEdits = {};
let socket = null;

let loadedImages = [];
let totalImages = 0;
let totalPages = 0;
let currentPage = 0;
let currentGlobalIndex = -1;
let currentImageName = null;
let currentLabels = [];
let undoStack = [];
let selectedBoxIdx = -1;
let mode = 'draw';
let drawing = false;
let drawStart = null;
let drawCurrent = null;
let currentFilter = 'all';
let currentSearch = '';
let hasUnsavedChanges = false;

let canvas, ctx;
let img = new Image();
let imgLoaded = false;
let scale = 1;
let offsetX = 0, offsetY = 0;
let imgW = 0, imgH = 0;

let dragging = false;
let dragStart = null;
let resizing = false;
let resizeHandle = null;

// Polygon drawing state
let polygonPoints = [];
let polygonDragging = false;
let polygonDragIdx = -1;
let polygonHoverIdx = -1;

// Constants
const BBOX_COLORS = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#00bcd4'];
const HANDLE_SIZE = 6;
const PER_PAGE = 100;
