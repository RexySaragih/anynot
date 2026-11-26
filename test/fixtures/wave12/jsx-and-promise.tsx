export interface ClickHandler {
  (event: { type: string }): void;
}

export interface ButtonProps {
  onClick: ClickHandler;
  label: string;
}

declare function Button(props: ButtonProps): JSX.Element;

export interface User {
  id: number;
  name: string;
}

export function fetchUser(): Promise<any> {
  return Promise.resolve({ id: 1, name: 'Ada' });
}

export async function useFetched(): Promise<string> {
  const user = await fetchUser();
  return user.name;
}

export function thenFetched(): void {
  fetchUser().then((user: User) => {
    void user.id;
  });
}

export function renderButton(): JSX.Element {
  const handler = ((event) => {
    void event.type;
  }) as any;
  return <Button onClick={handler} label="Go" />;
}

// Wide / Object-like — should not stay high
export const bag: any = Object.create(null);

// Fix target: Promise<any> whole-node rewrite candidate when inner is known
export function loadAccount(): Promise<any> {
  return Promise.resolve({ id: 2, name: 'Lin' } as User);
}
