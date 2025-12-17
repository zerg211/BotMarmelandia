
export enum FulfillmentType {
  FBO = 'FBO',
  FBS = 'FBS',
  FRESH = 'Ozon Fresh',
  R_FBS = 'rFBS'
}

export enum TaxSystem {
  USN_INCOME = 'УСН Доходы',
  USN_PROFIT = 'УСН Доходы-Расходы'
}

export enum PaymentSchedule {
  STANDARD = 'Стандарт',
  FAST = 'Досрочные',
  FLEXIBLE = 'Гибкий'
}

export interface OzonCategory {
  name: string;
  category_id: number;
  commissionFBO: number;
  commissionFBS: number;
}

export interface OzonApiCategory {
  category_id: number;
  title: string;
  children: OzonApiCategory[];
}

export interface CalculatorState {
  fulfillment: FulfillmentType;
  svdTime: number; 
  returnsRate: number; 
  selectedCategory: OzonCategory | null;
  priceInputMode: 'price' | 'margin';
  sellingPrice: number;
  costPrice: number;
  paymentSchedule: PaymentSchedule;
  hasOzonBank: boolean;
  advertisingRate: number;
  otherExpenses: number;
  taxSystem: TaxSystem;
  taxRate: number;
  vat: string;
  length: number;
  width: number;
  height: number;
  weight: number;
}

export interface CalculationResult {
  margin: number;
  netProfit: number;
  roi: number;
  commission: number;
  acquiring: number;
  logistics: number;
  lastMile: number;
  returnsCost: number;
  tax: number;
  totalExpenses: number;
  ozonReward: number;
}
