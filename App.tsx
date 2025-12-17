
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { FulfillmentType, TaxSystem, PaymentSchedule, CalculatorState, OzonCategory } from './types';
import { calculateOzonEconomics } from './services/calculatorLogic';
import { fetchOzonCategoryTree } from './services/ozonApiService';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'calculator'>('calculator');
  const [state, setState] = useState<CalculatorState>({
    fulfillment: FulfillmentType.FBO,
    svdTime: 45,
    returnsRate: 5,
    selectedCategory: null,
    priceInputMode: 'price',
    sellingPrice: 1500,
    costPrice: 500,
    paymentSchedule: PaymentSchedule.STANDARD,
    hasOzonBank: true,
    advertisingRate: 10,
    otherExpenses: 0,
    taxSystem: TaxSystem.USN_INCOME,
    taxRate: 6,
    vat: 'Без НДС',
    length: 20,
    width: 15,
    height: 5,
    weight: 0.5
  });

  const [allCategories, setAllCategories] = useState<OzonCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchOzonCategoryTree().then(cats => {
      setAllCategories(cats);
      setIsLoading(false);
    });
  }, []);

  const suggestions = useMemo(() => {
    if (!search || search.length < 2) return [];
    const lowSearch = search.toLowerCase();
    return allCategories
      .filter(c => c.name.toLowerCase().includes(lowSearch))
      .slice(0, 15);
  }, [search, allCategories]);

  const result = useMemo(() => calculateOzonEconomics(state), [state]);
  const update = (key: keyof CalculatorState, val: any) => setState(p => ({ ...p, [key]: val }));

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="min-h-screen bg-[#F1F5F9] font-sans text-[#0F172A]">
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-[60] shadow-sm">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-[#005BFF] rounded-xl flex items-center justify-center shadow-lg shadow-blue-200">
              <i className="fas fa-calculator text-white"></i>
            </div>
            <span className="font-black text-xl tracking-tight uppercase">
              Ozon<span className="text-[#005BFF]">Calc</span>
            </span>
          </div>
          <div className="flex bg-slate-100 p-1 rounded-xl">
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={`px-6 py-2 text-xs font-black rounded-lg transition-all ${activeTab === 'dashboard' ? 'bg-white shadow text-[#005BFF]' : 'text-slate-500'}`}
            >
              ОБЗОР
            </button>
            <button 
              onClick={() => setActiveTab('calculator')}
              className={`px-6 py-2 text-xs font-black rounded-lg transition-all ${activeTab === 'calculator' ? 'bg-white shadow text-[#005BFF]' : 'text-slate-500'}`}
            >
              КАЛЬКУЛЯТОР
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-4 md:p-8">
        {activeTab === 'dashboard' ? (
          <div className="bg-white p-20 rounded-[32px] text-center shadow-sm border border-slate-200">
             <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6 text-[#005BFF]">
                <i className="fas fa-history text-3xl"></i>
             </div>
             <h2 className="text-2xl font-black mb-2">История расчетов</h2>
             <p className="text-slate-400 max-w-sm mx-auto">Здесь появятся ваши сохраненные товары для быстрого сравнения.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-8 animate-fadeIn">
            
            <div className="space-y-6">
              <section className="bg-white rounded-[24px] p-6 shadow-sm border border-slate-200">
                <h3 className="text-sm font-black mb-6 uppercase tracking-widest text-slate-400">Товар и категория</h3>
                <div className="space-y-6">
                  <div className="relative" ref={dropdownRef}>
                    <input 
                      placeholder={isLoading ? "Загрузка категорий..." : "Поиск категории товара..."}
                      value={search || (state.selectedCategory?.name || '')}
                      onChange={e => { setSearch(e.target.value); setShowDropdown(true); }}
                      onFocus={() => setShowDropdown(true)}
                      className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-100 focus:border-[#005BFF] font-bold text-sm"
                    />
                    {showDropdown && suggestions.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-slate-200 rounded-xl shadow-2xl z-[100] max-h-60 overflow-y-auto p-2">
                        {suggestions.map((cat, i) => (
                          <div 
                            key={i} 
                            onClick={() => { update('selectedCategory', cat); setSearch(''); setShowDropdown(false); }}
                            className="p-3 hover:bg-blue-50 hover:text-[#005BFF] cursor-pointer text-xs font-bold rounded-lg mb-1 last:mb-0"
                          >
                            {cat.name}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[FulfillmentType.FBO, FulfillmentType.FBS, FulfillmentType.FRESH, FulfillmentType.R_FBS].map(type => (
                      <button
                        key={type}
                        onClick={() => update('fulfillment', type)}
                        className={`py-3 rounded-xl border font-black text-[10px] transition-all ${state.fulfillment === type ? 'border-[#005BFF] bg-blue-50 text-[#005BFF]' : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50'}`}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="bg-white rounded-[24px] p-6 shadow-sm border border-slate-200">
                <h3 className="text-sm font-black mb-6 uppercase tracking-widest text-slate-400">Стоимость</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 block">Цена продажи (₽)</label>
                    <input type="number" value={state.sellingPrice} onChange={e => update('sellingPrice', +e.target.value)} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-black text-xl outline-none focus:border-[#005BFF]" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 block">Себестоимость (₽)</label>
                    <input type="number" value={state.costPrice} onChange={e => update('costPrice', +e.target.value)} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl font-black text-xl outline-none focus:border-[#005BFF]" />
                  </div>
                </div>
              </section>

              <section className="bg-white rounded-[24px] p-6 shadow-sm border border-slate-200">
                <h3 className="text-sm font-black mb-6 uppercase tracking-widest text-slate-400">Габариты (см / кг)</h3>
                <div className="grid grid-cols-4 gap-3">
                  {['length', 'width', 'height', 'weight'].map(key => (
                    <div key={key}>
                      <input 
                        type="number" 
                        value={state[key as keyof CalculatorState] as number} 
                        onChange={e => update(key as any, +e.target.value)} 
                        className="w-full p-3 bg-white border border-slate-200 rounded-xl text-center font-bold text-sm outline-none focus:border-[#005BFF]"
                      />
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div className="space-y-6">
              <div className="lg:sticky lg:top-24">
                <div className="bg-[#1E293B] rounded-[32px] p-8 text-white shadow-xl">
                  <div className="mb-8">
                    <p className="text-slate-400 text-[10px] font-black uppercase mb-1">Прибыль за единицу</p>
                    <h2 className="text-5xl font-black tracking-tight text-white">
                      {Math.round(result.netProfit).toLocaleString()} <span className="text-xl text-slate-500">₽</span>
                    </h2>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mb-8">
                    <div className="bg-white/5 p-4 rounded-2xl border border-white/5">
                      <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Маржа</p>
                      <p className={`text-xl font-black ${result.margin > 15 ? 'text-emerald-400' : 'text-rose-400'}`}>{Math.round(result.margin)}%</p>
                    </div>
                    <div className="bg-white/5 p-4 rounded-2xl border border-white/5">
                      <p className="text-[9px] font-black text-slate-400 uppercase mb-1">ROI</p>
                      <p className="text-xl font-black text-blue-400">{Math.round(result.roi)}%</p>
                    </div>
                  </div>

                  <div className="space-y-4 pt-6 border-t border-white/10 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Комиссия Ozon</span>
                      <span className="font-bold">{Math.round(result.commission)} ₽</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Логистика (всего)</span>
                      <span className="font-bold">{Math.round(result.logistics + result.lastMile)} ₽</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Налоги</span>
                      <span className="font-bold text-rose-400">-{Math.round(result.tax)} ₽</span>
                    </div>
                  </div>

                  <button className="w-full mt-8 py-4 bg-[#005BFF] hover:bg-blue-600 rounded-xl font-black text-xs uppercase tracking-widest transition-all">
                    Сохранить товар
                  </button>
                </div>

                <div className="mt-4 p-5 bg-white rounded-2xl border border-slate-200 flex items-center justify-between">
                  <span className="text-[10px] font-black text-slate-400 uppercase">Ozon Банк (-1.2%)</span>
                  <button 
                    onClick={() => update('hasOzonBank', !state.hasOzonBank)}
                    className={`w-10 h-5 rounded-full transition-all relative ${state.hasOzonBank ? 'bg-[#005BFF]' : 'bg-slate-200'}`}
                  >
                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${state.hasOzonBank ? 'right-1' : 'left-1'}`}></div>
                  </button>
                </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
};

export default App;
