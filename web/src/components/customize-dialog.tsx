"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { LayersIcon, BotIcon, PlugIcon } from "lucide-react";
import { SkillsPanel } from "@/components/skills-panel";
import { ConnectorsPanel } from "@/components/connectors-panel";
import { SubagentsPanel } from "@/components/subagents-panel";

export function CustomizeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "sm:max-w-2xl h-[min(560px,80dvh)] flex flex-col gap-0 p-0 overflow-hidden"
        )}
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle>Customize</DialogTitle>
          <DialogDescription className="text-xs">
            Manage the skills, specialists, and connectors available to the agent.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue="skills"
          orientation="vertical"
          className="flex-1 min-h-0 flex flex-row gap-0"
        >
          <TabsList
            variant="line"
            className="w-44 shrink-0 border-r rounded-none px-2 py-3 items-start justify-start"
          >
            <TabsTrigger
              value="skills"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <LayersIcon className="size-3.5" />
              Skills
            </TabsTrigger>
            <TabsTrigger
              value="specialists"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <BotIcon className="size-3.5" />
              Specialists
            </TabsTrigger>
            <TabsTrigger
              value="connectors"
              className="justify-start gap-2 px-3 text-xs w-full"
            >
              <PlugIcon className="size-3.5" />
              Connectors
            </TabsTrigger>
          </TabsList>

          <TabsContent value="skills" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <SkillsPanel />
          </TabsContent>
          <TabsContent value="specialists" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <SubagentsPanel />
          </TabsContent>
          <TabsContent value="connectors" className="flex-1 min-h-0 p-5 overflow-y-auto">
            <ConnectorsPanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
