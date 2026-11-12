package main

import (
	"errors"
	"fmt"
	"time"
)

type SyncPlanSchedule struct {
	Frequency string `json:"frequency"`
	Time      string `json:"time"`
	Weekday   int    `json:"weekday"`
}

func (s SyncPlanSchedule) clock() (time.Time, error) {
	if s.Frequency != "daily" && s.Frequency != "weekly" {
		return time.Time{}, errors.New("请选择每天或每周执行")
	}
	if s.Weekday < 0 || s.Weekday > 6 {
		return time.Time{}, errors.New("请选择有效的星期")
	}
	clock, err := time.Parse("15:04", s.Time)
	if err != nil || clock.Format("15:04") != s.Time {
		return time.Time{}, errors.New("执行时间必须使用 HH:MM 格式")
	}
	return clock, nil
}

// Civil days use UTC as a calendar so AddDate remains valid across local
// offset changes, including a midnight that the local clock skipped.
func syncCivilDay(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// Resolve a repeated time to its first occurrence. A skipped time runs at
// the first valid instant after the jump.
func syncWallTime(day, clock time.Time, loc *time.Location) time.Time {
	wall := day.Add(time.Duration(clock.Hour())*time.Hour + time.Duration(clock.Minute())*time.Minute)
	cursor := wall.Add(-48 * time.Hour).In(loc)
	end := wall.Add(48 * time.Hour)
	var exact, shifted time.Time
	for cursor.Before(end) {
		_, offset := cursor.Zone()
		candidate := wall.Add(-time.Duration(offset) * time.Second).In(loc)
		y, m, d := candidate.Date()
		if y == wall.Year() && m == wall.Month() && d == wall.Day() &&
			candidate.Hour() == wall.Hour() && candidate.Minute() == wall.Minute() && candidate.Second() == 0 &&
			(exact.IsZero() || candidate.Before(exact)) {
			exact = candidate
		}
		_, next := cursor.ZoneBounds()
		if next.IsZero() || !next.After(cursor) || !next.Before(end) {
			break
		}
		next = next.In(loc)
		nextWall := syncCivilDay(next).Add(time.Duration(next.Hour())*time.Hour + time.Duration(next.Minute())*time.Minute + time.Duration(next.Second())*time.Second)
		if !nextWall.Before(wall) && (shifted.IsZero() || next.Before(shifted)) {
			shifted = next
		}
		cursor = next
	}
	if !exact.IsZero() {
		return exact
	}
	if !shifted.IsZero() {
		return shifted
	}
	return time.Date(day.Year(), day.Month(), day.Day(), clock.Hour(), clock.Minute(), 0, 0, loc)
}

type syncSlot struct {
	day string
	at  time.Time
}

// Only the newest due slot matters. Missed runs use the same incremental
// archive cursor, so enqueuing every missed day would repeat the same work.
func syncPlanSlots(s SyncPlanSchedule, eligible time.Time, last string, now time.Time) (due, next syncSlot) {
	clock, err := s.clock()
	if err != nil {
		return
	}
	today := syncCivilDay(now)
	matches := func(day time.Time) bool {
		return s.Frequency == "daily" || int(day.Weekday()) == s.Weekday
	}
	slot := func(day time.Time) syncSlot {
		return syncSlot{day.Format(time.DateOnly), syncWallTime(day, clock, now.Location())}
	}
	for day := today; !day.Before(today.AddDate(0, 0, -7)); day = day.AddDate(0, 0, -1) {
		if !matches(day) {
			continue
		}
		candidate := slot(day)
		if !candidate.at.After(now) {
			if candidate.day > last && !candidate.at.Before(eligible) {
				due = candidate
			}
			break
		}
	}
	first := today
	if eligible.After(now) {
		first = syncCivilDay(eligible.In(now.Location()))
	}
	if lastDay, err := time.Parse(time.DateOnly, last); err == nil && !lastDay.Before(first) {
		first = lastDay.AddDate(0, 0, 1)
	}
	for day := first; !day.After(first.AddDate(0, 0, 7)); day = day.AddDate(0, 0, 1) {
		if !matches(day) {
			continue
		}
		candidate := slot(day)
		if candidate.at.After(now) && !candidate.at.Before(eligible) {
			next = candidate
			break
		}
	}
	return due, next
}

func validateSyncPlanSlot(slot string) error {
	if slot == "" {
		return nil
	}
	if _, err := time.Parse(time.DateOnly, slot); err != nil {
		return fmt.Errorf("无效的同步计划时段 %q", slot)
	}
	return nil
}
