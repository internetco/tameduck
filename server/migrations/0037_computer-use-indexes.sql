-- Every load of the workspace asks what each run did with its computer
-- (server/computer-runs.mjs): the company's runs, their actions, and the other
-- runs in each run's conversation. Without these it read every action and
-- every job on the server to answer for one company.
CREATE INDEX computer_actions_job ON computer_actions(job_id, tool);
CREATE INDEX jobs_conversation ON jobs(conversation_id);
