document.addEventListener('DOMContentLoaded', function() {
    const tg = window.Telegram.WebApp;
    if (tg) {
        tg.expand();
    }

    const serverUrl = 'https://botmarmelandia.onrender.com';

    // --- ОБЩАЯ ЛОГИКА ВКЛАДОК ---
    window.showTab = (tabName) => {
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
        document.getElementById(tabName).classList.add('active');
        document.querySelector(`.tab-button[onclick="showTab('${tabName}')"]`).classList.add('active');
    };

    // --- ЛОГИКА ВКЛАДКИ "ПРОДАЖИ" ---
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
        errorEl.textContent = message;
        errorEl.style.display = 'block';
        loadingEl.style.display = 'none';
    };

    const fetchSalesData = async () => {
        const clientId = localStorage.getItem('ozonClientId');
        const apiKey = localStorage.getItem('ozonApiKey');
        if (!clientId || !apiKey) {
            authForm.style.display = 'block';
            salesDataEl.style.display = 'none';
            return;
        }

        loadingEl.style.display = 'block';
        salesDataEl.style.display = 'none';
        errorEl.style.display = 'none';

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
            totalQuantityEl.textContent = data.totalQuantity;
            totalPriceEl.textContent = data.totalPrice;
            salesDataEl.style.display = 'block';
            authForm.style.display = 'none';
        } catch (error) {
            displayError(`Ошибка: ${error.message}`);
            authForm.style.display = 'block';
            salesDataEl.style.display = 'none';
            localStorage.removeItem('ozonClientId');
            localStorage.removeItem('ozonApiKey');
        } finally {
            loadingEl.style.display = 'none';
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
            clientIdInput.value = '';
            apiKeyInput.value = '';
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', fetchSalesData);
    }

    // При загрузке страницы проверяем, есть ли сохраненные ключи
    fetchSalesData();

    // --- ЛОГИКА ВКЛАДКИ "КАЛЬКУЛЯТОР" ---
    let allCategories = [];

    const categorySearchInput = document.getElementById('category-search');
    const categoryResultsContainer = document.getElementById('category-results');
    const commissionInput = document.getElementById('commission');

    const loadCategories = async () => {
        try {
            const response = await fetch(`${serverUrl}/api/categories`);
            if (!response.ok) throw new Error('Could not load categories');
            allCategories = await response.json();
            categorySearchInput.placeholder = "Начните вводить категорию...";
        } catch (error) {
            console.error(error);
            if(categorySearchInput) categorySearchInput.placeholder = "Не удалось загрузить категории";
        }
    };

    const selectCategory = (category) => {
        categorySearchInput.value = category.title;
        commissionInput.value = category.commission;
        categoryResultsContainer.innerHTML = '';
        categoryResultsContainer.style.display = 'none';
    };

    if (categorySearchInput) {
        categorySearchInput.addEventListener('input', () => {
            const query = categorySearchInput.value.toLowerCase().trim();
            if (query.length < 2) {
                categoryResultsContainer.style.display = 'none';
                return;
            }
            const filtered = allCategories.filter(cat => cat.title.toLowerCase().includes(query));
            
            categoryResultsContainer.innerHTML = '';
            if (filtered.length === 0) {
                categoryResultsContainer.style.display = 'none';
                return;
            }

            filtered.slice(0, 50).forEach(cat => {
                const div = document.createElement('div');
                div.className = 'category-item';
                div.textContent = cat.title;
                div.addEventListener('click', () => selectCategory(cat));
                categoryResultsContainer.appendChild(div);
            });
            categoryResultsContainer.style.display = 'block';
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
    const lastMile = parseFloat(document.getElementById('last-mile').value) || 0;
    const taxRate = parseFloat(document.getElementById('tax-rate').value) || 0;

    if (sellPrice === 0) {
        alert("Цена продажи не может быть равна нулю.");
        return;
    }
    if (commissionPercent === 0) {
        alert("Выберите категорию, чтобы подтянуть комиссию.");
        return;
    }

    const commissionValue = sellPrice * (commissionPercent / 100);
    const totalExpenses = purchasePrice + commissionValue + logistics + lastMile;

    const profitBeforeTax = sellPrice - totalExpenses;
    const taxValue = (sellPrice - purchasePrice) * (taxRate / 100);
    const profitAfterTax = profitBeforeTax - taxValue;
    const margin = (sellPrice === 0) ? 0 : (profitBeforeTax / sellPrice) * 100;

    document.getElementById('profit-before-tax').textContent = `${profitBeforeTax.toFixed(2)} ₽`;
    document.getElementById('profit-after-tax').textContent = `${profitAfterTax.toFixed(2)} ₽`;
    document.getElementById('margin').textContent = `${margin.toFixed(2)} %`;

    document.getElementById('calc-results').style.display = 'block';
}
