# C1c: profiles in settings

Status: current
Owner: src/config/

Imported in order with cherry-pick -x: 53d1c7a73da3e6e9b47fdc62d5a5a419d3451b16, 8acf38c32133a1bc5ea90311849e8ed799a8e36b, 45c91677176c2220403d9000b2fe9e75745149a8.

The profile retention test fails before import (agentProfiles omitted), then all 156 tests in the five schema/run-mode/config-shape/preservation files pass. The parser has no runtime tool/provider authorization responsibility; validation of admitted tool names is required at loading/application. Existing protected config paths and agent-child write prohibitions are unchanged.

Conflicts in compatibility docs and the run-mode tests retain every fork orchestratorReasoning, unbounded reasoning, team and project option, while adding the profile map and its skip/preservation contract.
