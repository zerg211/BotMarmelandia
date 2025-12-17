
import { OzonApiCategory, OzonCategory } from '../types';

const CLIENT_ID = (typeof process !== 'undefined' && process.env.OZON_CLIENT_ID) || '';
const API_KEY = (typeof process !== 'undefined' && process.env.OZON_API_KEY) || '';

const FALLBACK_CATEGORIES: OzonCategory[] = [
  { name: "Электроника > Смартфоны", category_id: 1, commissionFBO: 8, commissionFBS: 10 },
  { name: "Электроника > Ноутбуки", category_id: 2, commissionFBO: 6, commissionFBS: 8 },
  { name: "Дом > Освещение", category_id: 3, commissionFBO: 15, commissionFBS: 17 },
  { name: "Одежда > Женская", category_id: 4, commissionFBO: 18, commissionFBS: 20 },
  { name: "Красота > Уход", category_id: 5, commissionFBO: 12, commissionFBS: 14 }
];

export const fetchOzonCategoryTree = async (): Promise<OzonCategory[]> => {
  if (!CLIENT_ID || !API_KEY) return FALLBACK_CATEGORIES;

  try {
    const response = await fetch('https://api-seller.ozon.ru/v1/categories/tree', {
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        'Api-Key': API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ category_id: 0, language: 'DEFAULT' })
    });
    if (!response.ok) return FALLBACK_CATEGORIES;
    const data = await response.json();
    return flattenCategories(data.result);
  } catch (error) {
    return FALLBACK_CATEGORIES;
  }
};

function flattenCategories(nodes: OzonApiCategory[], path: string = ''): OzonCategory[] {
  let result: OzonCategory[] = [];
  for (const node of nodes) {
    const currentPath = path ? `${path} > ${node.title}` : node.title;
    if (node.children && node.children.length > 0) {
      result = [...result, ...flattenCategories(node.children, currentPath)];
    } else {
      result.push({ name: currentPath, category_id: node.category_id, commissionFBO: 15, commissionFBS: 17 });
    }
  }
  return result;
}
