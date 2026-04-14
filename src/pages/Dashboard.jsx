import React from 'react';
import BudgetSensorsDashboard from '../components/dashboard/BudgetSensorsDashboard';

/**
 * Panel de control: vista premium Budget & Sensors (sin parrilla de widgets heredada).
 */
const Dashboard = () => (
  <div className="page-budget-dashboard" style={{ margin: '-8px -12px 0' }}>
    <BudgetSensorsDashboard variant="panel" />
  </div>
);

export default Dashboard;
