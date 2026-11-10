"use client";

import { useMutation, useQuery } from "@spacefast/zero/client";
import { Badge, Button, Card, Checkbox, EmptyState, Input } from "@spacefast/zero/kit";
import { cleanTodoText, type Todo } from "../shared/todo";

export default function TodoPage() {
  const todos = useQuery<Todo[]>("todos") ?? [];
  const addTodo = useMutation<[text: string], void>("addTodo");
  const setDone = useMutation<[id: string, done: boolean], void>("setDone");
  const remaining = todos.filter((todo) => !todo.done).length;

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const text = cleanTodoText(String(new FormData(form).get("text") ?? ""));
    if (!text) return;
    await addTodo(text);
    form.reset();
  }

  return (
    <Card
      title="Nextmove"
      subtitle="Stored in the capsule database; changes land live in every open tab."
      footer={
        remaining === 0 ? (
          <Badge tone="success">All done</Badge>
        ) : (
          <Badge tone="accent">{remaining} open</Badge>
        )
      }
    >
      <form class="flex gap-2" onSubmit={(event) => void onSubmit(event)}>
        <Input name="text" placeholder="Add a todo" aria-label="New todo" />
        <Button type="submit">Add</Button>
      </form>
      {todos.length === 0 ? (
        <div class="mt-4">
          <EmptyState title="Nothing to do" description="Add the first todo above." />
        </div>
      ) : (
        <ul class="mt-4 divide-y divide-line">
          {todos.map((todo) => (
            <li key={todo.id} class="flex items-center gap-3 py-2.5">
              <Checkbox checked={todo.done} onChange={() => void setDone(todo.id, !todo.done)} />
              <span class={todo.done ? "text-sm text-ink-muted line-through" : "text-sm text-ink"}>
                {todo.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

