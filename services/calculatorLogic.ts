
import { CalculatorState, CalculationResult, FulfillmentType } from '../types';

export const calculateOzonEconomics = (state: CalculatorState): CalculationResult => {
  const {
    sellingPrice, costPrice, fulfillment, svdTime, returnsRate,
    advertisingRate, otherExpenses, taxRate, length, width, height, weight,
    hasOzonBank, selectedCategory
  } = state;

  // 1. Комиссия маркетплейса
  const commRate = selectedCategory 
    ? (fulfillment === FulfillmentType.FBO ? selectedCategory.commissionFBO : selectedCategory.commissionFBS)
    : 15;
  const commission = (sellingPrice * commRate) / 100;

  // 2. Эквайринг
  const acquiring = sellingPrice * (hasOzonBank ? 0.012 : 0.015);

  // 3. Логистика (Объемный вес + СВД)
  const volumeLiters = (length * width * height) / 1000;
  const svdFactor = 1 + (svdTime - 45) * 0.002; 
  
  let baseLogistics = 0;
  if (fulfillment === FulfillmentType.FBO) {
    baseLogistics = 58 + Math.max(0, volumeLiters - 1) * 7;
  } else {
    baseLogistics = 70 + volumeLiters * 8;
  }
  const logistics = baseLogistics * svdFactor;

  // 4. Последняя миля (5.5%, min 60, max 500)
  const lastMile = Math.min(Math.max(sellingPrice * 0.055, 60), 500);

  // 5. Возвраты (усредненно 5% риска)
  const returnsFactor = returnsRate / 100;
  const returnsCost = (logistics * 0.8 + 50) * returnsFactor;

  // 6. Налоги
  const tax = sellingPrice * (taxRate / 100);

  // 7. Реклама
  const promo = (sellingPrice * advertisingRate) / 100;

  const totalOzonFee = commission + acquiring + logistics + lastMile + returnsCost + promo;
  const totalExpenses = costPrice + totalOzonFee + otherExpenses + tax;
  const netProfit = sellingPrice - totalExpenses;
  
  return {
    margin: sellingPrice > 0 ? (netProfit / sellingPrice) * 100 : 0,
    netProfit,
    roi: costPrice > 0 ? (netProfit / costPrice) * 100 : 0,
    commission,
    acquiring,
    logistics,
    lastMile,
    returnsCost,
    tax,
    totalExpenses,
    ozonReward: commission + acquiring + logistics + lastMile
  };
};
