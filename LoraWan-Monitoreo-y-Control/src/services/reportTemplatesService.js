import axios from 'axios';
import { getApiBase } from '../config/apiBase';
import { getAuthToken } from './localAuth';

const SERVER_API = getApiBase();

const authHeaders = () => ({
  Authorization: `Bearer ${getAuthToken()}`,
  'Content-Type': 'application/json',
});

export async function fetchReportTemplates() {
  const response = await axios.get(`${SERVER_API}/report-templates`, { headers: authHeaders() });
  return response.data.templates || [];
}

export async function saveReportTemplate(payload) {
  const response = await axios.post(`${SERVER_API}/report-templates`, payload, { headers: authHeaders() });
  return response.data.template;
}

export async function deleteReportTemplate(templateId) {
  await axios.delete(`${SERVER_API}/report-templates/${encodeURIComponent(templateId)}`, {
    headers: authHeaders(),
  });
}
