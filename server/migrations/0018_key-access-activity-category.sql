-- Keep existing key access changes beside the other Secrets activity.
UPDATE audit SET kind='secrets' WHERE action='Ducks allowed to use a key';
