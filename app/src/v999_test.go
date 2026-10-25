package main

import (
 "os"
 "strings"
 "testing"
)

// Guard specifically against v9.9.8's visible message-card blink after search.
func TestV999NoCardAnimationReset(t *testing.T) {
 js, err := os.ReadFile("ui/tak-bridge.js"); if err != nil { t.Fatal(err) }
 css, err := os.ReadFile("ui/tak-bridge.css"); if err != nil { t.Fatal(err) }
 app, err := os.ReadFile("ui/app.js"); if err != nil { t.Fatal(err) }
 j, c, a := string(js), string(css), string(app)
 if strings.Contains(j, "card.classList.add('tak-locating')") || strings.Contains(j, "card.classList.remove('tak-locating')") {
  t.Fatal("search must never change card animation state: doing so replays upstream slideIn from opacity 0")
 }
 if strings.Contains(c, ".tak-locating{animation:") || strings.Contains(c, ".tak-locating{animation:none") {
  t.Fatal("legacy card pulse must not override upstream slideIn")
 }
 if !strings.Contains(j,"halo.classList.add('is-active')") || !strings.Contains(j,"halo.classList.remove('is-active')") {
  t.Fatal("only the independent halo may be animated")
 }
 if !strings.Contains(a,"state.anchor='';state.dateTarget=r.date") {
  t.Fatal("global date navigation must use date row, never a message hash")
 }
 if !strings.Contains(c,"#date-navigation.active") || !strings.Contains(c,"--tak-fab-edge:12px") {
  t.Fatal("real upstream date navigation z-order and floating spacing need to remain aligned")
 }
 if !strings.Contains(j,"options.style.overflowY=natural<=allowed?'hidden':'auto'") {
  t.Fatal("page menu must not show scrollbar when all items fit")
 }
}
