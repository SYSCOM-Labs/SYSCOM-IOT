import React from 'react';
import { motion as Motion } from 'framer-motion';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

const GaugeWidget = ({ title, value, unit }) => {
  const parsedValue = parseFloat(value);
  const hasValue = Number.isFinite(parsedValue);
  const numericValue = hasValue ? parsedValue : 0;
  
  // Custom thresholds for the gauge (e.g. 0 to 50 scale)
  const min = 0;
  const max = 50; 
  const percentage = Math.max(0, Math.min(100, ((numericValue - min) / (max - min)) * 100));

  // Determine color based on value
  let color = 'var(--success)';
  if (numericValue > 30) color = 'var(--warning)';
  if (numericValue > 40) color = 'var(--danger)';
  if (numericValue < 10) color = 'var(--accent-blue)';

  const data = [
    { name: 'Value', value: percentage },
    { name: 'Empty', value: 100 - percentage },
  ];

  return (
    <Motion.div
      aria-label={title || 'Medidor'}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
    >
      <div style={{ height: '150px', width: '100%', position: 'relative' }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="80%" // Move down since it's a half circle
              startAngle={180}
              endAngle={0}
              innerRadius="70%"
              outerRadius="90%"
              paddingAngle={0}
              dataKey="value"
              stroke="none"
              cornerRadius={4}
            >
              <Cell key="cell-0" fill={color} />
              <Cell key="cell-1" fill="var(--bg-secondary)" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: 'absolute', top: '55%', left: '0', width: '100%', textAlign: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '2.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {hasValue ? numericValue.toFixed(1) : '--'}
          </h2>
          <span style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>{unit}</span>
          {!hasValue && (
            <div style={{ marginTop: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Sin datos
            </div>
          )}
        </div>
      </div>
    </Motion.div>
  );
};

export default GaugeWidget;
