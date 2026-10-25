package main

import (
    "os"
    "strings"
    "testing"
)

// A regression guard for v9.9.6's full-viewport rectangular media hit target.
func TestV997MediaSurfaceKeepsIntrinsicDimensionsAndRoundedCorners(t *testing.T) {
    script, err := os.ReadFile("ui/tak-lightbox.js")
    if err != nil { t.Fatal(err) }
    css, err := os.ReadFile("ui/tak-lightbox.css")
    if err != nil { t.Fatal(err) }
    for _, want := range []string{"function sizeMedia(", "video.videoWidth/video.videoHeight", "stage.addEventListener('click'", "previewRatio(", "preloadNeighbors()", "startWait(g)"} {
        if !strings.Contains(string(script), want) { t.Errorf("lightbox behavior missing %s", want) }
    }
    for _, want := range []string{".tak-lb-media-box", "pointer-events:none", "pointer-events:auto", "border-radius:16px", "background:transparent"} {
        if !strings.Contains(string(css), want) { t.Errorf("lightbox surface missing %s", want) }
    }
    if strings.Contains(string(css), ".tak-lb-media-box{position:relative;width:min(100%,1180px);height:100%") {
        t.Fatal("fixed rectangular lightbox media stage returned")
    }
}

func TestV997FloatingControlsAndMessageHalo(t *testing.T) {
    b, err := os.ReadFile("ui/tak-bridge.css")
    if err != nil { t.Fatal(err) }
    js, err := os.ReadFile("ui/tak-bridge.js")
    if err != nil { t.Fatal(err) }
    for _, want := range []string{"--tak-fab:56px", "--tak-fab-hover", "--tak-fab-easing", "opacity .22s ease", "visibility 0s linear .22s", "takMessageHalo", ".tak-search-highlight.is-active"} {
        if !strings.Contains(string(b), want) { t.Errorf("floating animation missing %s", want) }
    }
    for _, want := range []string{"takLocateTimers", "clearTimeout(previous.start)", "clearTimeout(previous.stop)"} {
        if !strings.Contains(string(js), want) { t.Errorf("overlapping locate cancellation missing %s", want) }
    }
}
