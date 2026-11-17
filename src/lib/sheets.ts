// Google Sheets access — now used ONLY for the Accomplishments log.
// The roadmap itself and requests live in ClickUp (see ./clickup.ts).
import { google } from 'googleapis';

function getAuth() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!credentials) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set');
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(credentials);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
  }

  return new google.auth.GoogleAuth({
    credentials: parsed,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

// ==========================================
// ACCOMPLISHMENTS — stored in a separate workbook (or tab)
// Read still flows through the published CSV in the API route;
// writes go through the Sheets API here.
// ==========================================

export interface Accomplishment {
  Feature: string;
  Theme: string;
  OKR: string;
  'Impact Size': string;
  'Impact Notes': string;
  'Completed Date': string;
}

const ACC_COLUMNS = ['Feature', 'Theme', 'OKR', 'Impact Size', 'Impact Notes', 'Completed Date'] as const;

function getAccomplishmentsSheetId(): string {
  return process.env.GOOGLE_ACCOMPLISHMENTS_SHEET_ID || '1KIeteYhzmalB8ykEnU_i3UtuQxj31nvIxaTvoE9tl9U';
}

async function getAccomplishmentsSheetName(): Promise<string> {
  if (process.env.GOOGLE_ACCOMPLISHMENTS_SHEET_NAME) return process.env.GOOGLE_ACCOMPLISHMENTS_SHEET_NAME;
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: getAccomplishmentsSheetId() });
  const sheet = meta.data.sheets?.find(s => s.properties?.sheetId === 0);
  return sheet?.properties?.title || 'Sheet1';
}

export async function getAccomplishments(): Promise<Array<Accomplishment & { id: string }>> {
  const sheets = await getSheets();
  const spreadsheetId = getAccomplishmentsSheetId();
  const sheetName = await getAccomplishmentsSheetName();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:F`,
  });
  const rows = res.data.values || [];
  if (rows.length < 1) return [];
  const headers = rows[0].map(h => String(h || '').trim());
  return rows.slice(1)
    .filter(r => r.some(c => String(c || '').trim() !== ''))
    .map((r, idx) => {
      const obj: Record<string, string> = { id: String(idx) };
      headers.forEach((h, i) => { obj[h] = String(r[i] || '').trim(); });
      return obj as unknown as Accomplishment & { id: string };
    });
}

export async function addAccomplishment(item: Accomplishment): Promise<Accomplishment> {
  const sheets = await getSheets();
  const spreadsheetId = getAccomplishmentsSheetId();
  const sheetName = await getAccomplishmentsSheetName();
  const row = ACC_COLUMNS.map(col => item[col] || '');
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  return item;
}
