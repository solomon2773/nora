import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function buildGradientId(key) {
  return `metrics-gradient-${String(key || "series").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function resolveDomain(data, keys, explicitDomain) {
  const values = data
    .flatMap((entry) => keys.map((key) => entry?.[key]))
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (values.length === 0) {
    return explicitDomain || [0, "auto"];
  }

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  let min = Array.isArray(explicitDomain) && explicitDomain[0] !== "auto"
    ? explicitDomain[0]
    : dataMin;
  let max = Array.isArray(explicitDomain) && explicitDomain[1] !== "auto"
    ? explicitDomain[1]
    : dataMax;

  if (min === max) {
    if (max === 0) {
      max = 1;
    } else {
      const padding = Math.abs(max) * 0.1;
      min = Math.min(min, 0);
      max += padding;
    }
  }

  return [min, max];
}

export default function MetricsAreaChart({
  color,
  data,
  dataKey,
  domain,
  legend,
  secondColor,
  secondDataKey,
  title,
  unit,
}) {
  const gradientId = buildGradientId(dataKey);
  const secondGradientId = secondDataKey ? buildGradientId(secondDataKey) : null;
  const yDomain = resolveDomain(
    data,
    secondDataKey ? [dataKey, secondDataKey] : [dataKey],
    domain
  );

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
          {secondGradientId && (
            <linearGradient id={secondGradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={secondColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={secondColor} stopOpacity={0.02} />
            </linearGradient>
          )}
        </defs>
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 9, fill: "#64748b" }}
          interval="preserveStartEnd"
          axisLine={false}
          tickLine={false}
          minTickGap={20}
        />
        <YAxis
          tick={{ fontSize: 9, fill: "#64748b" }}
          domain={yDomain}
          width={44}
          axisLine={false}
          tickLine={false}
          padding={{ top: 8, bottom: 8 }}
        />
        <Tooltip
          contentStyle={{
            fontSize: 10,
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            padding: "4px 8px",
          }}
          formatter={(value, name) => {
            const label = legend ? (name === dataKey ? legend[0] : legend[1]) : title;
            if (value == null) {
              return ["Unavailable", label];
            }
            return [`${Number(value).toFixed(2)}${unit || ""}`, label];
          }}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          fill={`url(#${gradientId})`}
          strokeWidth={2}
          connectNulls
          dot={data.length === 1 ? { r: 2, strokeWidth: 1.5 } : false}
          activeDot={data.length === 1 ? { r: 3 } : { r: 3 }}
          isAnimationActive={false}
        />
        {secondDataKey && (
          <Area
            type="monotone"
            dataKey={secondDataKey}
            stroke={secondColor}
            fill={`url(#${secondGradientId})`}
            strokeWidth={2}
            connectNulls
            dot={data.length === 1 ? { r: 2, strokeWidth: 1.5 } : false}
            activeDot={data.length === 1 ? { r: 3 } : { r: 3 }}
            isAnimationActive={false}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}
