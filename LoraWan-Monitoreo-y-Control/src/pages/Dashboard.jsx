import React from 'react';
import BudgetSensorsDashboard from '../components/dashboard/BudgetSensorsDashboard';

/**
 * Panel de control: misma instancia de `BudgetSensorsDashboard` que el modal de detalle
 * de cada dispositivo (`variant="device"`); correcciones de rejilla/widgets aplican aquí y allí.
 */
const Dashboard = () => (
  <div className="page-budget-dashboard">
    <BudgetSensorsDashboard variant="panel" />
  </div>
);

export default Dashboard;
