import React, { useMemo } from 'react';
import './Widgets.css';
import { motion as Motion } from 'framer-motion';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

const CHART_COLORS = [
  'var(--chart-color-1)',
  'var(--chart-color-2)',
  'var(--chart-color-3)',
  'var(--chart-color-4)',
  'var(--chart-color-5)',
  'var(--chart-color-6)',
];

const tooltipStyle = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  boxShadow: 'var(--shadow-md)',
  fontSize: '12px',
};

/**
 * @param {'area' | 'line' | 'bar' | 'pie' | 'donut'} type
 */
const ChartWidget = ({ title, value, data = [], type = 'area' }) => {
  const series = useMemo(() => {
    if (Array.isArray(data) && data.length > 0) return data;
    const current = parseFloat(value);
    if (!Number.isFinite(current)) return [];
    return [{ time: 'Ahora', val: current }];
  }, [data, value]);

  const pieSlices = useMemo(() => {
    if (series.length < 1) return [];
    const tail = series.slice(-8);
    return tail.map((d, i) => ({
      name: d.time || `T${i + 1}`,
      value: Math.max(0, Number(d.val) || 0),
    }));
  }, [series]);

  const gradientId = `chartGrad-${type}-${title?.slice(0, 8) || 'w'}`;

  const chartBody = () => {
    if (type === 'line') {
      return (
        <LineChart data={series}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
          <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis hide />
          <Tooltip contentStyle={tooltipStyle} itemStyle={{ color: 'var(--text-primary)' }} />
          <Line type="monotone" dataKey="val" stroke="var(--chart-color-1)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--chart-color-1)' }} activeDot={{ r: 5 }} />
        </LineChart>
      );
    }
    if (type === 'bar') {
      return (
        <BarChart data={series}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
          <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis hide />
          <Tooltip contentStyle={tooltipStyle} itemStyle={{ color: 'var(--text-primary)' }} />
          <Bar dataKey="val" radius={[8, 8, 0, 0]} fill="var(--chart-color-2)" />
        </BarChart>
      );
    }
    if (type === 'pie' || type === 'donut') {
      if (pieSlices.length === 0) {
        return null;
      }
      const inner = type === 'donut' ? '56%' : 0;
      const outer = '88%';
      return (
        <PieChart>
          <Tooltip contentStyle={tooltipStyle} itemStyle={{ color: 'var(--text-primary)' }} />
          <Pie data={pieSlices} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={inner} outerRadius={outer} paddingAngle={2}>
            {pieSlices.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="var(--bg-card)" strokeWidth={1} />
            ))}
          </Pie>
        </PieChart>
      );
    }
    /* area */
    return (
      <AreaChart data={series}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-color-1)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--chart-color-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
        <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} />
        <YAxis hide />
        <Tooltip contentStyle={tooltipStyle} itemStyle={{ color: 'var(--text-primary)' }} />
        <Area type="monotone" dataKey="val" stroke="var(--chart-color-1)" strokeWidth={2} fillOpacity={1} fill={`url(#${gradientId})`} />
      </AreaChart>
    );
  };

  const empty = series.length === 0 || (type !== 'area' && type !== 'line' && type !== 'bar' && pieSlices.length === 0);

  return (
    <Motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="soft-chart-widget"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div className="soft-chart-widget__header">
        <span className="soft-chart-widget__title">{title}</span>
        <span className="soft-chart-widget__hint">Últ. 12 h</span>
      </div>
      <div className="soft-chart-widget__body">
        {!empty ? (
          <ResponsiveContainer width="100%" height="100%">
            {chartBody()}
          </ResponsiveContainer>
        ) : (
          <div className="soft-chart-widget__empty">Sin datos en el rango</div>
        )}
      </div>
    </Motion.div>
  );
};

export default ChartWidget;
