use serde::Serialize;

const HOUR: i64 = 3_600_000;
const WEEK: i64 = 7 * 24 * HOUR;
const METHODS: [&str; 3] = ["week_average", "trailing_7d", "weekday_hour"];

#[derive(Default)]
pub(super) struct PriceSeries {
    points: Vec<(i64, f64)>,
    prefix: Vec<f64>,
}

impl PriceSeries {
    pub fn push(&mut self, timestamp: i64, amount: f64) {
        self.points.push((timestamp, amount));
    }
    pub fn seal(&mut self) {
        self.prefix.push(0.);
        for (_, amount) in &self.points {
            self.prefix.push(self.prefix.last().unwrap() + amount);
        }
    }
    fn sum(&self, start: i64, end: i64) -> (f64, usize) {
        let a = self.points.partition_point(|point| point.0 < start);
        let b = self.points.partition_point(|point| point.0 < end);
        (self.prefix[b] - self.prefix[a], b - a)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Comparison {
    method: &'static str,
    folds: usize,
    mae: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ForecastSummary {
    currency: String,
    method: &'static str,
    projected_amount: Option<f64>,
    projected_subtotal: Option<f64>,
    observed_subtotal: f64,
    additional_subtotal: Option<f64>,
    priced_requests: i64,
    unpriced_requests: i64,
    coverage: &'static str,
    time_basis: &'static str,
    reason: &'static str,
    comparisons: Vec<Comparison>,
}

fn predict(
    method: &str,
    series: &PriceSeries,
    data_start: i64,
    week_start: i64,
    cutoff: i64,
    end: i64,
) -> Option<f64> {
    if cutoff < week_start || end < cutoff {
        return None;
    }
    if end == cutoff {
        return Some(0.);
    }
    if method != "weekday_hour" {
        let start = if method == "trailing_7d" {
            cutoff - WEEK
        } else {
            week_start
        };
        if start < data_start || start >= cutoff {
            return None;
        }
        let (amount, count) = series.sum(start, cutoff);
        return (count > 0).then_some(amount * (end - cutoff) as f64 / (cutoff - start) as f64);
    }
    let mut amount = 0.;
    let mut matched_requests = 0;
    let mut slot = cutoff;
    while slot < end {
        let next = ((slot.div_euclid(HOUR) + 1) * HOUR).min(end);
        let mut sum = 0.;
        let mut matches = 0;
        for lag in 1..=3 {
            let start = slot - lag * WEEK;
            let stop = next - lag * WEEK;
            if start >= data_start && stop <= cutoff {
                let (value, requests) = series.sum(start, stop);
                sum += value;
                matched_requests += requests;
                matches += 1;
            }
        }
        if matches == 0 {
            return None;
        }
        amount += sum / matches as f64;
        slot = next;
    }
    (matched_requests > 0).then_some(amount)
}

pub(super) fn forecast(
    currency: &str,
    series: &PriceSeries,
    data_start: Option<i64>,
    start: i64,
    cutoff: i64,
    end: Option<i64>,
    observed_subtotal: f64,
    priced_requests: i64,
    unpriced_requests: i64,
) -> ForecastSummary {
    let mut result = ForecastSummary {
        currency: currency.into(),
        method: "week_average",
        projected_amount: None,
        projected_subtotal: None,
        observed_subtotal,
        additional_subtotal: None,
        priced_requests,
        unpriced_requests,
        coverage: "observed_records_only",
        time_basis: "UTC",
        reason: "forecast_horizon_unspecified",
        comparisons: Vec::new(),
    };
    let Some(end) = end else {
        return result;
    };
    if priced_requests == 0 {
        result.reason = "no_priced_reference_records";
        return result;
    }
    if cutoff <= start || end < cutoff {
        result.reason = "insufficient_elapsed_window";
        return result;
    }
    let data_start = data_start.unwrap_or(cutoff);
    let horizon = end - cutoff;
    let mut errors = [0.; 3];
    let mut folds = 0;
    if horizon > 0 {
        for lag in 1..=3 {
            let cut = cutoff - lag * WEEK;
            let origin = start - lag * WEEK;
            let (actual, actual_requests) = series.sum(cut, cut + horizon);
            if actual_requests == 0 || cut + horizon > cutoff {
                continue;
            }
            let values: Option<Vec<_>> = METHODS
                .iter()
                .map(|method| predict(method, series, data_start, origin, cut, cut + horizon))
                .collect();
            if let Some(values) = values {
                for (error, value) in errors.iter_mut().zip(values) {
                    *error += (value - actual).abs();
                }
                folds += 1;
            }
        }
    }
    // A single held-out interval does not select a method. Empty slots mean no stored records, not zero actual use.
    if folds >= 2 {
        result.comparisons = METHODS
            .iter()
            .zip(errors)
            .map(|(method, error)| Comparison {
                method,
                folds,
                mae: error / folds as f64,
            })
            .collect();
        let best = result
            .comparisons
            .iter()
            .min_by(|a, b| a.mae.total_cmp(&b.mae))
            .unwrap();
        result.method = best.method;
    }
    result.additional_subtotal = predict(result.method, series, data_start, start, cutoff, end);
    if result.additional_subtotal.is_none() {
        result.method = "week_average";
        result.additional_subtotal =
            Some(observed_subtotal * horizon as f64 / (cutoff - start) as f64);
    }
    result.projected_subtotal = result
        .additional_subtotal
        .map(|additional| observed_subtotal + additional);
    result.reason = if folds >= 2 {
        "chronological_mae_on_same_stored_priced_records_only_not_full_usage"
    } else {
        "insufficient_comparable_history_week_average_of_recorded_subtotal_not_full_usage"
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidate_training_never_uses_records_at_or_after_the_cutoff() {
        let mut history = PriceSeries::default();
        for week in 0..4 {
            for day in 0..7 {
                history.push(week * WEEK + day * 24 * HOUR, 1.);
            }
        }
        history.seal();
        let before: Vec<_> = METHODS
            .iter()
            .map(|method| {
                predict(
                    method,
                    &history,
                    0,
                    3 * WEEK,
                    3 * WEEK + 2 * 24 * HOUR,
                    3 * WEEK + 4 * 24 * HOUR,
                )
            })
            .collect();
        let mut with_future = PriceSeries::default();
        for &(time, amount) in &history.points {
            with_future.push(
                time,
                if time >= 3 * WEEK + 2 * 24 * HOUR {
                    1_000_000.
                } else {
                    amount
                },
            );
        }
        with_future.seal();
        let after: Vec<_> = METHODS
            .iter()
            .map(|method| {
                predict(
                    method,
                    &with_future,
                    0,
                    3 * WEEK,
                    3 * WEEK + 2 * 24 * HOUR,
                    3 * WEEK + 4 * 24 * HOUR,
                )
            })
            .collect();
        assert_eq!(before, after);
    }
    #[test]
    fn observed_only_backtest_uses_equal_horizons_and_short_history_does_not_rank() {
        let mut series = PriceSeries::default();
        for week in 0..4 {
            for day in 0..7 {
                series.push(
                    week * WEEK + day * 24 * HOUR,
                    if day >= 5 { 10. } else { 1. },
                );
            }
        }
        series.seal();
        let result = forecast(
            "USD",
            &series,
            Some(0),
            3 * WEEK,
            3 * WEEK + 5 * 24 * HOUR,
            Some(4 * WEEK),
            5.,
            5,
            0,
        );
        assert_eq!(result.comparisons.len(), 3);
        assert_eq!(result.method, "weekday_hour");
        assert_eq!(result.additional_subtotal, Some(20.));
        assert_eq!(result.projected_subtotal, Some(25.));
        assert_eq!(result.projected_amount, None);
        assert_eq!(result.coverage, "observed_records_only");
        assert!(result
            .comparisons
            .iter()
            .all(|comparison| comparison.folds == 2));
        let short = forecast(
            "USD",
            &series,
            Some(3 * WEEK),
            3 * WEEK,
            3 * WEEK + 5 * 24 * HOUR,
            Some(4 * WEEK),
            5.,
            5,
            1,
        );
        assert!(short.comparisons.is_empty());
        assert_eq!(short.method, "week_average");
        assert_eq!(short.projected_subtotal, Some(7.));
        assert_eq!(short.unpriced_requests, 1);
    }
}
