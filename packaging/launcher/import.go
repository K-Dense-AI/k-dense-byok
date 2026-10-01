package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Keep IDs, sessions, provenance, jobs and budget ledgers intact by selecting
// the existing projects root in place. Never merge or overwrite research data.
func selectCheckout(p paths, source string) error {
	source, e := filepath.Abs(source)
	if e != nil {
		return e
	}
	root := filepath.Join(source, "projects")
	if filepath.Base(source) == "projects" {
		root = source
		source = filepath.Dir(source)
	}
	b, e := os.ReadFile(filepath.Join(root, "index.json"))
	if e != nil {
		return errors.New("Choose a Kady checkout containing projects/index.json")
	}
	var registry struct {
		Projects map[string]json.RawMessage `json:"projects"`
	}
	if e = json.Unmarshal(b, &registry); e != nil || registry.Projects == nil {
		return errors.New("The existing projects registry is invalid")
	}
	// Copy configuration only when no configuration exists. Pi credentials stay
	// in the existing ~/.kady/pi-agent directory and are never copied or printed.
	target := filepath.Join(p.Config, ".env")
	if _, e = os.Stat(target); os.IsNotExist(e) {
		if config, e := os.ReadFile(filepath.Join(source, ".env")); e == nil {
			f, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil {
				return e
			}
			_, e = f.Write(config)
			closeErr := f.Close()
			if e != nil {
				return e
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
	settings, _ := json.Marshal(map[string]string{"projectsRoot": root})
	return atomicFile(filepath.Join(p.Config, "workspace.json"), settings)
}
func projectsRoot(p paths) string {
	if explicit := os.Getenv("KADY_PROJECTS_ROOT"); explicit != "" {
		return explicit
	}
	if b, e := os.ReadFile(filepath.Join(p.Config, "workspace.json")); e == nil {
		var settings struct {
			ProjectsRoot string `json:"projectsRoot"`
		}
		if json.Unmarshal(b, &settings) == nil && filepath.IsAbs(settings.ProjectsRoot) {
			return settings.ProjectsRoot
		}
	}
	return filepath.Join(p.Data, "projects")
}
func importCheckout(p paths, source string) error {
	if s, e := readInstance(p); e == nil && live(s) {
		return errors.New("Stop Kady before selecting an existing installation")
	}
	if e := selectCheckout(p, source); e != nil {
		return e
	}
	fmt.Println("Kady will use the existing projects directory in place. Stop the source installation before starting Kady.")
	return nil
}
