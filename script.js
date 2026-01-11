document.addEventListener('DOMContentLoaded', function() {
    const tg = window.Telegram.WebApp;
    if (tg) {
        tg.expand();
    }

    const serverUrl = 'https://botmarmelandia.onrender.com';

    window.showTab = (tabName) => {
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
        document.getElementById(tabName).classList.add('active');
        document.querySelector(`.tab-button[onclick="showTab('${tabName}')"]`).classList.add('active');
    };

    const clientIdInput = document.getElementById('clientId');
    const apiKeyInput = document.getElementById('apiKey');
    const saveBtn = document.getElementById('save-credentials');
    const logoutBtn = document.getElementById('logout');
    const refreshBtn = document.getElementById('refresh-data');
    const authForm = document.getElementById('auth-form');
    const salesDataEl = document.getElementById('sales-data');
    const loadingEl = document.getElementById('loading');
    const errorEl = document.getElementById('error');
    const totalQuantityEl = document.getElementById('total-quantity');
    const totalPriceEl = document.getElementById('total-price');

    const displayError = (message) => {
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }
        if(loadingEl) loadingEl.style.display = 'none';
    };

    const fetchSalesData = async () => {
        const clientId = localStorage.getItem('ozonClientId');
        const apiKey = localStorage.getItem('ozonApiKey');
        if (!clientId || !apiKey) {
            if (authForm) authForm.style.display = 'block';
            if (salesDataEl) salesDataEl.style.display = 'none';
            return;
        }
        
        if(loadingEl) loadingEl.style.display = 'block';
        if(authForm) authForm.style.display = 'none';
        if(salesDataEl) salesDataEl.style.display = 'none';
        if(errorEl) errorEl.style.display = 'none';

        try {
            const response = await fetch(`${serverUrl}/api/sales`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, apiKey }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            if(totalQuantityEl) totalQuantityEl.textContent = data.totalQuantity;
            if(totalPriceEl) totalPriceEl.textContent = data.totalPrice;
            if(salesDataEl) salesDataEl.style.display = 'block';
            if(authForm) authForm.style.display = 'none';
        } catch (error) {
            displayError(`Ошибка: ${error.message}`);
            if (authForm) authForm.style.display = 'block';
            if(salesDataEl) salesDataEl.style.display = 'none';
            localStorage.removeItem('ozonClientId');
            localStorage.removeItem('ozonApiKey');
        } finally {
            if(loadingEl) loadingEl.style.display = 'none';
        }
    };

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const clientId = clientIdInput.value.trim();
            const apiKey = apiKeyInput.value.trim();
            if (clientId && apiKey) {
                localStorage.setItem('ozonClientId', clientId);
                localStorage.setItem('ozonApiKey', apiKey);
                fetchSalesData();
            } else {
                displayError('Пожалуйста, введите Client-Id и Api-Key.');
            }
        });
    }
    
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            localStorage.removeItem('ozonClientId');
            localStorage.removeItem('ozonApiKey');
            authForm.style.display = 'block';
            salesDataEl.style.display = 'none';
            if(clientIdInput) clientIdInput.value = '';
            if(apiKeyInput) apiKeyInput.value = '';
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', fetchSalesData);
    }

    fetchSalesData();

    let allCategories = [];
    const categorySearchInput = document.getElementById('category-search');
    const categoryResultsContainer = document.getElementById('category-results');
    const commissionInput = document.getElementById('commission');

    const loadCategories = async () => {
        try {
            const response = await fetch(`${serverUrl}/api/categories`);
            if (!response.ok) throw new Error('Could not load categories');
            allCategories = await response.json();
            if(categorySearchInput) categorySearchInput.placeholder = "Начните вводить категорию...";
        } catch (error) {
            console.error(error);
            if(categorySearchInput) categorySearchInput.placeholder = "Не удалось загрузить категории";
        }
    };

    const selectCategory = (category) => {
        if(categorySearchInput) categorySearchInput.value = category.title;
        if(commissionInput) commissionInput.value = category.commission;
        if(categoryResultsContainer) {
            categoryResultsContainer.innerHTML = '';
            categoryResultsContainer.style.display = 'none';
        }
    };

    if (categorySearchInput) {
        categorySearchInput.addEventListener('input', () => {
            const query = categorySearchInput.value.toLowerCase().trim();
            if (query.length < 2) {
                if(categoryResultsContainer) categoryResultsContainer.style.display = 'none';
                return;
            }
            const filtered = allCategories.filter(cat => cat.title.toLowerCase().includes(query));
            
            if(categoryResultsContainer) categoryResultsContainer.innerHTML = '';
            if (filtered.length === 0) {
                if(categoryResultsContainer) categoryResultsContainer.style.display = 'none';
                return;
            }

            filtered.slice(0, 50).forEach(cat => {
                const div = document.createElement('div');
                div.className = 'category-item';
                div.textContent = cat.title;
                div.addEventListener('click', () => selectCategory(cat));
                categoryResultsContainer.appendChild(div);
            });
            if(categoryResultsContainer) categoryResultsContainer.style.display = 'block';
        });
    }

    document.addEventListener('click', (e) => {
        if (categoryResultsContainer && !e.target.closest('.category-search-container')) {
            categoryResultsContainer.style.display = 'none';
        }
    });

    loadCategories();
});

window.calculateUnitEconomy = function() {
    const purchasePrice = parseFloat(document.getElementById('purchase-price').value) || 0;
    const sellPrice = parseFloat(document.getElementById('sell-price').value) || 0;
    const commissionPercent = parseFloat(document.getElementById('commission').value) || 0;
    const logistics = parseFloat(document.getElementById('logistics').value) || 0;
    const lastMilePercent = parseFloat(document.getElementById('last-mile').value) || 0;
    const taxRate = parseFloat(document.getElementById('tax-rate').value) || 0;

    if (sellPrice <= 0) {
        alert("Цена продажи должна быть больше нуля.");
        return;
    }
    if (commissionPercent <= 0) {
        alert("Выберите категорию, чтобы подтянуть комиссию.");
        return;
    }

    const commissionValue = sellPrice * (commissi
